"""
The talking attendance agent.

It listens, speaks, and does as it is told. Every decision - what to ask, what
an answer means, which date comes next, when to hang up - belongs to the
platform's turn API, which is the same code the keypad calls run on. This
worker never invents a question and never decides an outcome.

That split is deliberate. An agent free to improvise would eventually record an
absence differently from the keypad call for the same employee on the same day,
and nobody would know which was right.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import aiohttp
from dotenv import load_dotenv
from livekit import agents, api
from livekit.agents import Agent, AgentSession, JobContext, StopResponse, WorkerOptions, cli
from livekit.plugins import openai, sarvam, silero

load_dotenv()
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

log = logging.getLogger("attendance-agent")

ROOM_PREFIX = "attendance-call-"
APP_BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:3000")
AGENT_API_TOKEN = os.environ.get("AGENT_API_TOKEN", "")

# The voice belongs to the customer being called and is read from their
# settings; these are only the fallbacks for when the platform cannot be asked.
VOICE = os.environ.get("AGENT_VOICE", "ritu")
VOICE_MODEL = os.environ.get("AGENT_VOICE_MODEL", "bulbul:v3-beta")
VOICE_PACE = float(os.environ.get("AGENT_VOICE_PACE", "0.95"))
STT_VENDOR = os.environ.get("AGENT_STT", "sarvam")


@dataclass
class Turn:
    """One instruction from the platform: say this, then listen for that."""

    say: str
    next_case_id: str | None
    done: bool

    @classmethod
    def parse(cls, payload: dict) -> "Turn":
        return cls(
            say=payload.get("say") or "",
            next_case_id=payload.get("nextCaseId"),
            done=bool(payload.get("done")),
        )


class TurnApi:
    """The platform, as far as this worker is concerned."""

    def __init__(self, call_id: str, session: aiohttp.ClientSession) -> None:
        self._call_id = call_id
        self._http = session

    async def opening(self) -> Turn:
        return await self._post({})

    async def answer(self, case_id: str, speech: str) -> Turn:
        return await self._post({"caseId": case_id, "speech": speech})

    async def brief(self) -> dict:
        """Who is being called, and in whose voice. Asked before speaking."""
        async with self._http.post(
            f"{APP_BASE_URL}/api/agent/turn",
            json={"callId": self._call_id, "brief": True},
            headers={"x-agent-token": AGENT_API_TOKEN},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as response:
            response.raise_for_status()
            return await response.json()

    async def ended(self) -> None:
        """The line has dropped. Without this a call sits 'in progress' for ever."""
        try:
            await self._post({"ended": True})
        except Exception:
            log.exception("could not report the end of call %s", self._call_id)

    async def _post(self, body: dict) -> Turn:
        async with self._http.post(
            f"{APP_BASE_URL}/api/agent/turn",
            json={"callId": self._call_id, **body},
            headers={"x-agent-token": AGENT_API_TOKEN},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as response:
            response.raise_for_status()
            return Turn.parse(await response.json())


class AttendanceAgent(Agent):
    """
    The voice on the call.

    The instructions matter less than usual, because this agent is not allowed
    to answer on its own - `on_user_turn_completed` intercepts every turn. They
    exist so that speech recognition has some idea what the call is about.
    """

    def __init__(self, api: TurnApi) -> None:
        super().__init__(
            instructions=(
                "You are an attendance assistant for an Indian employer, calling an employee "
                "about days they were marked absent. You speak Indian English and understand "
                "Hindi and Hinglish. You are brief, polite and never argue."
            )
        )
        self._api = api
        self._case_id: str | None = None
        self._finished = False

    async def on_enter(self) -> None:
        """The employee has picked up. Ask the platform what to say first."""
        turn = await self._api.opening()
        self._case_id = turn.next_case_id
        await self.session.say(turn.say)
        if turn.done:
            await self._hang_up()

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:  # noqa: ANN001
        """
        The employee has said something.

        Their words go to the platform, which decides what they meant and what
        happens next. `StopResponse` stops the language model replying on its
        own - without it the agent would answer twice, once helpfully and once
        correctly.
        """
        if self._finished:
            raise StopResponse()

        said = (new_message.text_content or "").strip()
        if not said or not self._case_id:
            raise StopResponse()

        try:
            turn = await self._api.answer(self._case_id, said)
        except Exception:
            log.exception("turn API failed; handing the call over")
            await self.session.say(
                "Sorry, I am having trouble just now. Someone from H R will contact you. Goodbye."
            )
            await self._hang_up()
            raise StopResponse()

        self._case_id = turn.next_case_id
        await self.session.say(turn.say)
        if turn.done:
            await self._hang_up()
        raise StopResponse()

    async def _hang_up(self) -> None:
        self._finished = True
        await self.session.drain()
        ctx = agents.get_job_context()
        await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))


async def entrypoint(ctx: JobContext) -> None:
    call_id = ctx.room.name[len(ROOM_PREFIX):] if ctx.room.name.startswith(ROOM_PREFIX) else ""
    if not call_id:
        log.warning("room %s is not an attendance call; leaving it alone", ctx.room.name)
        return

    log.info("joining call %s", call_id)

    # `session.start()` returns once the agent is running, not when the call
    # ends, so this must not be closed in a `finally` around it - that shut the
    # connection mid-conversation and the agent apologised and hung up.
    http = aiohttp.ClientSession()
    api_client = TurnApi(call_id, http)

    async def on_shutdown() -> None:
        await api_client.ended()
        await http.close()

    ctx.add_shutdown_callback(on_shutdown)

    # The customer chooses the voice in the portal. Falling back to the
    # configured default keeps the call working if that lookup fails, because a
    # call in the wrong voice beats a call that never happens.
    try:
        brief = await api_client.brief()
        voice, pace = brief.get("voice") or VOICE, float(brief.get("pace") or VOICE_PACE)
        log.info("call %s speaks as %s at pace %s", call_id, voice, pace)
    except Exception:
        log.exception("could not read the voice for call %s; using the default", call_id)
        voice, pace = VOICE, VOICE_PACE

    session = AgentSession(
        # Ears and a voice. The decisions that matter are not made here - see
        # the class docstring.
        #
        # Sarvam is used for both by default: its voices are Indian rather than
        # an American accent reading Indian names, and it is trained on the
        # Hinglish people actually speak on the phone. A slightly slower pace
        # than natural helps on a bad line.
        stt=(
            sarvam.STT(language="en-IN")
            if STT_VENDOR == "sarvam"
            else openai.STT(model="gpt-4o-transcribe")
        ),
        # Present because AgentSession expects one, and used only for phrasing.
        # It never decides the flow: every turn is intercepted before it speaks.
        llm=openai.LLM(model="gpt-4o-mini"),
        tts=sarvam.TTS(
            target_language_code="en-IN",
            model=VOICE_MODEL,
            speaker=voice,
            pace=pace,
        ),
        vad=silero.VAD.load(),
    )

    await session.start(agent=AttendanceAgent(api_client), room=ctx.room)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
