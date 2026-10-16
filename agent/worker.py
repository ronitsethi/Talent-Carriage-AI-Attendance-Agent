"""
The talking attendance agent.

It listens, speaks, and does as it is told. What to say, what an answer means,
which date comes next and when to hang up all belong to the platform's turn
API: the conversation there writes each sentence and checks every outcome
against the customer's flow before recording it. This worker never invents a
question and never decides an outcome.

That split is deliberate. An agent free to improvise here would eventually
record an absence differently from the WhatsApp chat for the same employee on
the same day, and nobody would know which was right.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass

import aiohttp
from dotenv import load_dotenv
from livekit import agents, api
from livekit.agents import Agent, AgentSession, JobContext, JobProcess, StopResponse, WorkerOptions, cli
from livekit.plugins import openai, sarvam, silero

load_dotenv()
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

log = logging.getLogger("attendance-agent")

ROOM_PREFIX = "attendance-call-"
ASK_PREFIX = "attendance-ask"
APP_BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:3000")
AGENT_API_TOKEN = os.environ.get("AGENT_API_TOKEN", "")

# The voice belongs to the customer being called and is read from their
# settings; these are only the fallbacks for when the platform cannot be asked.
VOICE = os.environ.get("AGENT_VOICE", "ritu")
VOICE_MODEL = os.environ.get("AGENT_VOICE_MODEL", "bulbul:v3-beta")
VOICE_PACE = float(os.environ.get("AGENT_VOICE_PACE", "0.95"))
STT_VENDOR = os.environ.get("AGENT_STT", "sarvam")
# Azure OpenAI deployment names. The base URL comes from OPENAI_BASE_URL, which
# the OpenAI client reads itself.
LLM_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")
STT_MODEL = os.environ.get("OPENAI_STT_MODEL", "gpt-4o-transcribe")


# Sarvam finalises a transcript the moment it hears the end of speech, rather
# than waiting on its own timer; without this the caller waited about 0.7s more
# for their words to be written down before anything else could start.
STT_FLUSH = True

# Which language Sarvam listens for. "unknown" lets it tell for itself, sentence
# by sentence, so a caller who switches to Hindi is written down in Hindi - and
# answered in it - rather than squeezed into English. "codemix" writes Hinglish
# the way it is spoken: Hindi in Devanagari, the English words in English.
STT_LANGUAGE = os.environ.get("AGENT_STT_LANGUAGE", "unknown")
STT_MODE = os.environ.get("AGENT_STT_MODE", "codemix")

# The longest the agent waits, once the caller goes quiet, before treating the
# turn as over. LiveKit's turn detector waited its default of 2.5s whenever it
# thought the caller might go on, and on our calls it usually did - which was
# most of the silence after every question.
END_OF_TURN_MAX_S = 0.5

TURN_HANDLING = {
    "endpointing": {"max_delay": END_OF_TURN_MAX_S},
    "interruption": {
        # One word - "hello?", "haan" - is somebody saying they are there, not
        # somebody cutting in, and stopping mid-sentence for it left the caller
        # in two seconds of silence.
        "min_words": 2,
        # And when something does stop the agent and turns out to be nothing,
        # it carries on after a moment rather than after LiveKit's two seconds.
        "false_interruption_timeout": 0.6,
    },
}

# If no part of a reply has arrived by then, the caller hears this instead of
# silence. A colleague looking something up says as much.
FILLER_AFTER_S = 0.5
FILLER = "Okay, let me check."

# ...but not to "thank you" or "bye": there is nothing to check, and saying so
# sounds like a machine. The platform's model judges that, however it is put,
# while the transcript is still being written (`search_early`). These words are
# only the fallback for when its answer is not back in time. Whether the call is
# ending is a separate question, judged by the platform from the words.
PLEASANTRIES = set(
    (
        "thank thanks thankyou thanku thx you u so much very bye byee goodbye ok okay okk k fine great good nice "
        "alright right sure done cool perfect noted got it that's thats all nothing else no have a day "
        "dhanyavaad dhanyavad dhanyawad shukriya alvida theek thik hai haan han ji accha acha achha bas chalo nahi "
        "nahin sir madam mam "
        "धन्यवाद शुक्रिया थैंक यू बाय ठीक है हाँ हां जी अच्छा बस चलो नहीं ओके अलविदा"
    ).split()
)


# How much longer the filler waits for the platform's verdict before the word
# list decides instead.
CHECK_GRACE_S = 0.3


def only_pleasantries(said: str) -> bool:
    words = [w.strip(".,!?;:'\"।").lower() for w in said.split()]
    words = [w for w in words if w]
    return bool(words) and "?" not in said and all(w in PLEASANTRIES for w in words)


# On picking up, people say hello first. The agent waits this long for them to
# start; if they do, it introduces itself as soon as they stop.
GREETING_WAIT_S = 1.2
# Somebody ringing us expects to be greeted promptly.
INBOUND_GREETING_WAIT_S = 0.6
# How long a hello may go on before the agent speaks anyway.
GREETING_MAX_S = 4.0
# During the introduction, a turn this short is a greeting, not an answer.
GREETING_WORDS = 3

# About eight seconds in all, which covers a call placed inside a long-running
# batch without keeping anybody waiting on a call that genuinely does not exist.
_BACKOFF = (0.3, 0.6, 1.0, 1.5, 2.0, 2.5)
_RETRIES = len(_BACKOFF)


class _NotYet(Exception):
    """The platform has not finished writing this call down. Worth asking again."""


@dataclass
class Turn:
    """One instruction from the platform: say this, then listen for that."""

    say: str
    next_case_id: str | None
    done: bool
    language: str | None = None

    @classmethod
    def parse(cls, payload: dict) -> "Turn":
        return cls(
            say=payload.get("say") or "",
            next_case_id=payload.get("nextCaseId"),
            done=bool(payload.get("done")),
            language=payload.get("language"),
        )


class TurnApi:
    """The platform, as far as this worker is concerned."""

    def __init__(self, call_id: str, session: aiohttp.ClientSession) -> None:
        self._call_id = call_id
        self._http = session

    async def opening(self) -> Turn:
        """The introduction, written for this call. Asked for while it rings."""
        return await self._post({"talk": True})

    async def check(self) -> None:
        """
        Proves the platform is reachable before the phone is answered.

        The worker reads APP_BASE_URL once, at startup. Move the tunnel and
        restart the web app but not this, and every call connects, greets
        nobody and hangs up - which looks like a broken agent rather than a
        stale address.
        """
        async with self._http.post(
            f"{APP_BASE_URL}/api/agent/turn",
            json={"callId": "00000000-0000-0000-0000-000000000000"},
            headers={"x-agent-token": AGENT_API_TOKEN},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as response:
            # 404 is the right answer for a call that does not exist. Anything
            # else - 403 from a dead tunnel, 401 from a stale token - means this
            # worker cannot do its job.
            if response.status not in (200, 404):
                raise RuntimeError(f"{APP_BASE_URL} answered {response.status}; check APP_BASE_URL and AGENT_API_TOKEN")

    async def ask(self, caller: str, question: str | None) -> dict:
        """One turn of a call somebody made to us, rather than one we made."""
        return await self._raw({"ask": {"from": caller, "question": question}})

    def talk(self, case_id: str, speech: str):
        """One turn of a call we placed, a piece at a time - see `_stream`."""
        return self._stream({"callId": self._call_id, "caseId": case_id, "speech": speech, "talk": True, "stream": True})

    def ask_stream(self, caller: str, question: str, history: list[dict]):
        """One turn of a call somebody made to us, a piece at a time."""
        return self._stream({"ask": {"from": caller, "question": question}, "history": history, "stream": True})

    async def prepare(self, said: str, caller: str | None = None) -> bool | None:
        """
        Starts the guideline search on what has been heard so far.

        Sent the moment the caller stops talking. The final transcript takes
        Sarvam most of a second more, and the search runs in that time instead
        of after it. On a call somebody made to us, the platform also says
        whether the words are only a thank-you or goodbye - see `only_pleasantries`.
        """
        body = {"prepare": said, **({"ask": {"from": caller}} if caller else {"callId": self._call_id})}
        try:
            async with self._http.post(
                f"{APP_BASE_URL}/api/agent/turn",
                json=body,
                headers={"x-agent-token": AGENT_API_TOKEN},
                timeout=aiohttp.ClientTimeout(total=5),
            ) as response:
                payload = await response.json()
                return payload.get("onlyPleasantries")
        except Exception as problem:  # noqa: BLE001 - a missed head start costs only time
            log.warning("could not prepare the turn: %s", problem)
            return None

    async def _stream(self, body: dict):
        """
        A turn, as the platform writes it.

        Yields ("lang", code) first - the language the reply is in, so the voice
        can switch before it says anything - then each piece of the reply as
        text, then a final dict saying whether the call is over and which date
        comes next.
        """
        started = time.monotonic()
        first_at: float | None = None
        async with self._http.post(
            f"{APP_BASE_URL}/api/agent/turn",
            json=body,
            headers={"x-agent-token": AGENT_API_TOKEN},
            timeout=aiohttp.ClientTimeout(total=30),
        ) as response:
            response.raise_for_status()
            async for raw in response.content:
                line = raw.strip()
                if not line:
                    continue
                event = json.loads(line)
                kind = event.get("type")
                if kind == "lang":
                    yield ("lang", event.get("language") or "en-IN")
                elif kind == "text":
                    if first_at is None:
                        first_at = time.monotonic()
                        log.info("timing: first words of the reply after %.2fs", first_at - started)
                    yield event.get("text") or ""
                elif kind == "end":
                    log.info(
                        "timing: platform finished the turn in %.2fs (%s)",
                        time.monotonic() - started,
                        event.get("timing") or "no breakdown",
                    )
                    yield {"done": bool(event.get("done")), "next_case_id": event.get("nextCaseId")}
                    return
                elif kind == "error":
                    raise RuntimeError("the platform could not answer")
        raise RuntimeError("the reply stopped before it finished")

    async def brief(self) -> dict:
        """Who is being called, and in whose voice. Asked before speaking."""
        return await self._raw({"callId": self._call_id, "brief": True})

    async def _raw(self, body: dict) -> dict:
        return await self._send(body, timeout=30)

    async def _send(self, body: dict, *, timeout: int) -> dict:
        """
        One request to the platform, retried briefly if the call is not there yet.

        A 404 normally means what it says. On the first turn it can also mean
        the platform has not finished writing the call down: it inserts the call,
        asks LiveKit to dial, and commits - and LiveKit hands this worker the job
        the instant the room exists, which can be before that commit lands. The
        row is real and on its way; it is simply not visible yet on another
        connection.

        So a 404 is retried for a few seconds before it is believed. The cost is
        not symmetric - waiting costs a moment, giving up means somebody answers
        their phone to silence.
        """
        last: Exception | None = None
        for attempt in range(_RETRIES):
            started = time.monotonic()
            try:
                async with self._http.post(
                    f"{APP_BASE_URL}/api/agent/turn",
                    json=body,
                    headers={"x-agent-token": AGENT_API_TOKEN},
                    timeout=aiohttp.ClientTimeout(total=timeout),
                ) as response:
                    if response.status == 404 and attempt < _RETRIES - 1:
                        raise _NotYet()
                    response.raise_for_status()
                    payload = await response.json()
                    # What the platform says it spent, beside what the round trip cost.
                    log.info(
                        "timing: platform answered in %.2fs (%s)",
                        time.monotonic() - started,
                        response.headers.get("Server-Timing", "no breakdown"),
                    )
                    return payload
            except _NotYet as error:
                last = error
                await asyncio.sleep(_BACKOFF[attempt])
            except aiohttp.ClientResponseError:
                raise
        raise RuntimeError(f"call {self._call_id} never appeared on the platform") from last

    async def ended(self) -> None:
        """The line has dropped. Without this a call sits 'in progress' for ever."""
        try:
            await self._post({"ended": True})
        except Exception:
            log.exception("could not report the end of call %s", self._call_id)

    async def _post(self, body: dict) -> Turn:
        return Turn.parse(await self._send({"callId": self._call_id, **body}, timeout=15))


class TalkingAgent(Agent):
    """
    What both kinds of call share: speaking a reply as the platform writes it,
    in the language it is written in, and letting the caller say hello first.
    """

    def __init__(self, api: TurnApi, instructions: str) -> None:
        super().__init__(instructions=instructions)
        self._api = api
        self._finished = False
        # Until the introduction has been said, a hello is a hello, not an answer.
        self._greeting = True
        # Set by `search_early`, which keeps the words of the turn in progress.
        self.forget_heard = lambda: None
        self._check = None

    def _switch_language(self, language: str | None) -> None:
        """Sets the voice to the language of what it is about to say."""
        if not language:
            return
        try:
            self.session.tts.update_options(target_language_code=language)
        except Exception:  # noqa: BLE001 - the wrong accent beats no voice
            log.exception("could not switch the voice to %s", language)

    async def _speak_stream(self, stream, filler=None) -> tuple[dict, str]:  # noqa: ANN001
        """
        Speaks a reply while it is still being written.

        Returns the platform's verdict (done, next date) and what was said. The
        language arrives before the first word, so the voice is switched before
        speaking starts. `filler`, when given, is asked if nothing of the reply
        has arrived within FILLER_AFTER_S, and the filler is said if it agrees.
        """
        outcome: dict = {"done": False, "next_case_id": None}
        spoken: list[str] = []

        async def first_text() -> str | None:
            async for piece in stream:
                if isinstance(piece, tuple):
                    self._switch_language(piece[1])
                elif isinstance(piece, dict):
                    outcome.update(piece)
                    return None
                elif piece:
                    return piece
            return None

        first = asyncio.ensure_future(first_text())
        if filler:
            try:
                await asyncio.wait_for(asyncio.shield(first), FILLER_AFTER_S)
            except asyncio.TimeoutError:
                if await filler():
                    log.info("timing: nothing yet after %.1fs, saying the filler", FILLER_AFTER_S)
                    self.session.say(FILLER)
                else:
                    log.info("timing: nothing yet after %.1fs, but no filler for a pleasantry", FILLER_AFTER_S)
        opening = await first
        if opening is None:
            return outcome, ""

        async def rest():
            spoken.append(opening)
            yield opening
            try:
                async for piece in stream:
                    if isinstance(piece, dict):
                        outcome.update(piece)
                    elif isinstance(piece, str) and piece:
                        spoken.append(piece)
                        yield piece
            except Exception:
                # What was already said stands; the rest of this reply is lost.
                log.exception("the reply broke off part way")

        await self.session.say(rest())
        return outcome, "".join(spoken)

    async def _wait_for_hello(self, wait_s: float) -> None:
        """
        Gives the caller a moment to say hello, and lets them finish if they do.

        People answer the phone by speaking first. An agent that talks straight
        over them gets interrupted and then sits in silence; one that waits for
        "hello?", "haan bolo" or "kaun?" sounds like a person.
        """
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline and self.session.user_state != "speaking":
            await asyncio.sleep(0.05)
        if self.session.user_state != "speaking":
            return
        log.info("timing: the caller spoke first; introducing once they stop")
        deadline = time.monotonic() + GREETING_MAX_S
        while time.monotonic() < deadline and self.session.user_state == "speaking":
            await asyncio.sleep(0.05)

    def _is_greeting(self, said: str) -> bool:
        """A short turn before the introduction is over: their hello, not an answer."""
        return self._greeting and len(said.split()) <= GREETING_WORDS

    async def _hang_up(self) -> None:
        self._finished = True
        await self.session.drain()
        ctx = agents.get_job_context()
        await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))


class AttendanceAgent(TalkingAgent):
    """
    The voice on a call we placed.

    The language model attached to the session never answers on its own -
    `on_user_turn_completed` intercepts every turn and the platform writes the
    reply, so what is recorded is decided in one place. The instructions exist so
    speech recognition has some idea what the call is about.
    """

    def __init__(self, api: TurnApi, answered: asyncio.Event) -> None:
        super().__init__(
            api,
            instructions=(
                "You are an attendance assistant for an Indian employer, calling an employee "
                "about days they were marked absent. You speak Indian English and Hindi."
            ),
        )
        self._answered = answered
        self._case_id: str | None = None

    async def on_enter(self) -> None:
        """The phone is ringing. Have the introduction ready for when they pick up."""
        opening = asyncio.ensure_future(self._api.opening())
        await self._answered.wait()
        await self._wait_for_hello(GREETING_WAIT_S)
        try:
            turn = await opening
        except Exception:
            # Somebody has their phone to their ear. Whatever went wrong, saying
            # so and hanging up is better than thirty seconds of nothing.
            log.exception("could not open the call; apologising instead")
            self._switch_language("en-IN")
            await self.session.say(
                "Sorry, I am not able to continue this call right now. Someone from H R will call you back."
            )
            await self._hang_up()
            return

        self._case_id = turn.next_case_id
        self._switch_language(turn.language)
        await self.session.say(turn.say)
        self._greeting = False
        if turn.done:
            await self._hang_up()

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:  # noqa: ANN001
        log_turn_timing(new_message)
        self.forget_heard()
        said = (new_message.text_content or "").strip()
        if self._finished or not said or not self._case_id or self._is_greeting(said):
            raise StopResponse()

        try:
            outcome, _ = await self._speak_stream(self._api.talk(self._case_id, said))
        except Exception:
            log.exception("turn API failed; handing the call over")
            self._switch_language("en-IN")
            await self.session.say("Sorry, I am having trouble just now. Someone from H R will contact you. Goodbye.")
            await self._hang_up()
            raise StopResponse()

        self._case_id = outcome.get("next_case_id") or self._case_id
        if outcome.get("done"):
            await self._hang_up()
        raise StopResponse()


class QuestionAgent(TalkingAgent):
    """
    The voice when somebody rings us.

    It answers from the customer's own guidelines and this caller's own record,
    or says HR will come back to them. The caller's number is the only thing
    that says who they are.
    """

    def __init__(self, api: TurnApi, caller: str, greeting: dict) -> None:
        super().__init__(
            api,
            instructions=(
                "You are an attendance and HR assistant for an Indian employer, speaking to an "
                "employee who has telephoned in. You speak Indian English and Hindi."
            ),
        )
        self._caller = caller
        self._opening = greeting
        # Nothing is kept on the platform for a call somebody made to us, so
        # the conversation so far travels with each turn.
        self._history: list[dict] = []

    async def _wants_filler(self, said: str) -> bool:
        """
        Whether to say the filler: not for a pleasantry. The platform's verdict
        decides, given a moment more if it is nearly back; the word list if not.
        """
        check = self._check
        if check is not None:
            try:
                verdict = await asyncio.wait_for(asyncio.shield(check), CHECK_GRACE_S)
                if verdict is not None:
                    return not verdict
            except Exception:  # noqa: BLE001 - late or failed: the word list decides
                pass
        log.info("the pleasantry check was not back in time; using the word list")
        return not only_pleasantries(said)

    async def on_enter(self) -> None:
        await self._wait_for_hello(INBOUND_GREETING_WAIT_S)
        say = self._opening.get("say") or "Hello, this is the attendance assistant. How can I help?"
        self._switch_language(self._opening.get("language"))
        await self.session.say(say)
        self._history.append({"role": "agent", "text": say})
        self._greeting = False
        if self._opening.get("done"):
            await self._hang_up()

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:  # noqa: ANN001
        log_turn_timing(new_message)
        self._check = self.forget_heard()
        said = (new_message.text_content or "").strip()
        if self._finished or not said or self._is_greeting(said):
            raise StopResponse()

        try:
            outcome, spoken = await self._speak_stream(
                self._api.ask_stream(self._caller, said, self._history[-14:]),
                filler=lambda: self._wants_filler(said),
            )
        except Exception:
            log.exception("turn API failed on an incoming call")
            self._switch_language("en-IN")
            await self.session.say("Sorry, I am having trouble just now. Please contact your H R team. Goodbye.")
            await self._hang_up()
            raise StopResponse()

        self._history += [{"role": "employee", "text": said}, {"role": "agent", "text": spoken}]
        if outcome.get("done"):
            await self._hang_up()
        raise StopResponse()


def log_turn_timing(message) -> None:  # noqa: ANN001
    """
    How long it took to decide the caller had finished, and to have their words.

    LiveKit reports this through its own events only when it goes on to reply,
    and this agent never lets it - the platform replies - so it is read from the
    message here, where the numbers are already attached.
    """
    m = getattr(message, "metrics", None) or {}
    stopped = m.get("stopped_speaking_at")
    log.info(
        "timing: caller spoke %.1fs; end of turn decided %.2fs after silence, transcript %.2fs; "
        "%.2fs since they stopped",
        (stopped - m["started_speaking_at"]) if stopped and m.get("started_speaking_at") else -1,
        m.get("end_of_turn_delay", -1),
        m.get("transcription_delay", -1),
        (time.time() - stopped) if stopped else -1,
    )


def watch_timing(session: AgentSession) -> None:
    """
    Logs where the silence after each answer goes.

    The caller hears one gap: from when they stop talking to when the agent
    starts. It is made of deciding they have finished, the transcript, the
    platform's answer and the first audio of the reply, and these lines give
    each part so the slow one can be fixed rather than guessed at.
    """
    stopped: dict[str, float | None] = {"at": None}

    @session.on("user_state_changed")
    def _user(ev) -> None:  # noqa: ANN001
        if ev.old_state == "speaking" and ev.new_state == "listening":
            stopped["at"] = ev.created_at

    @session.on("agent_state_changed")
    def _agent(ev) -> None:  # noqa: ANN001
        if ev.new_state == "speaking" and stopped["at"] is not None:
            log.info("timing: caller stopped -> agent speaking %.2fs", ev.created_at - stopped["at"])
            stopped["at"] = None

    # The end-of-turn half of this event is never sent - see log_turn_timing.
    @session.on("metrics_collected")
    def _metrics(ev) -> None:  # noqa: ANN001
        m = ev.metrics
        if m.type == "tts_metrics" and not m.cancelled:
            log.info("timing: voice started %.2fs after the text was ready", m.ttfb)


def search_early(session: AgentSession, prepare):  # noqa: ANN001, ANN201
    """
    Starts the guideline search the moment the caller stops talking.

    Sarvam takes most of a second after that to hand over the final words, and
    the turn could not begin until it did. The words heard so far are almost
    always the question, so the search runs on them in that time instead.
    """
    heard: dict = {"final": [], "interim": "", "check": None}

    @session.on("user_input_transcribed")
    def _heard(ev) -> None:  # noqa: ANN001
        if ev.is_final:
            heard["final"].append(ev.transcript)
            heard["interim"] = ""
        else:
            heard["interim"] = ev.transcript

    @session.on("user_state_changed")
    def _stopped(ev) -> None:  # noqa: ANN001
        if ev.old_state == "speaking" and ev.new_state == "listening":
            said = " ".join([*heard["final"], heard["interim"]]).strip()
            if said:
                heard["check"] = asyncio.ensure_future(prepare(said))

    def forget():  # noqa: ANN202
        """
        A turn's words are spent once it has been answered. Returns the
        platform's pleasantry check for them, still running or done.
        """
        check = heard["check"]
        heard["final"].clear()
        heard["interim"] = ""
        heard["check"] = None
        return check

    return forget


async def wait_until_answered(room, answered: asyncio.Event) -> None:  # noqa: ANN001
    """
    Sets `answered` once the employee picks up.

    The phone is placed without waiting for an answer, so the employee is in the
    room from the first ring. Talking then meant the introduction played to a
    ringing phone, and the employee picked up in the middle of it. LiveKit marks
    the call "active" when it is answered; somebody joining another way - a test
    from the browser - has no call status and is there already.
    """

    def picked_up(participant) -> bool:  # noqa: ANN001
        status = participant.attributes.get("sip.callStatus")
        return status is None or status == "active"

    def check(*_args) -> None:  # noqa: ANN002
        if any(picked_up(p) for p in room.remote_participants.values()):
            answered.set()

    room.on("participant_attributes_changed", check)
    room.on("participant_connected", check)
    check()
    try:
        await answered.wait()
        log.info("the call was answered")
    finally:
        room.off("participant_attributes_changed", check)
        room.off("participant_connected", check)


def make_stt():  # noqa: ANN201
    return (
        sarvam.STT(language=STT_LANGUAGE, mode=STT_MODE, flush_signal=STT_FLUSH)
        if STT_VENDOR == "sarvam"
        else openai.STT(model=STT_MODEL)
    )


def prewarm(proc: JobProcess) -> None:
    """
    Loads the voice-activity model once per process, before any call arrives.

    Loading it inside the call made every caller wait for it before the
    greeting; a process handles call after call, so once is enough.
    """
    proc.userdata["vad"] = silero.VAD.load()


async def entrypoint(ctx: JobContext) -> None:
    inbound = ctx.room.name.startswith(ASK_PREFIX)
    call_id = ctx.room.name[len(ROOM_PREFIX):] if ctx.room.name.startswith(ROOM_PREFIX) else ""
    if not call_id and not inbound:
        log.warning("room %s is neither an attendance call nor a question; leaving it alone", ctx.room.name)
        return

    log.info("joining call %s, reporting to %s", call_id, APP_BASE_URL)

    # `session.start()` returns once the agent is running, not when the call
    # ends, so this must not be closed in a `finally` around it - that shut the
    # connection mid-conversation and the agent apologised and hung up.
    http = aiohttp.ClientSession()
    api_client = TurnApi(call_id, http)

    async def on_shutdown() -> None:
        await api_client.ended()
        await http.close()

    ctx.add_shutdown_callback(on_shutdown)

    try:
        await api_client.check()
    except Exception as problem:
        log.error("cannot reach the platform: %s", problem)
        raise

    # A call somebody made to us. The number they rang from is the only thing
    # that says who they are, and it arrives on the SIP participant.
    if inbound:
        participant = await ctx.wait_for_participant()
        caller = participant.attributes.get("sip.phoneNumber", "") if participant else ""
        log.info("incoming call from %s", caller or "an unknown number")

        brief = {}
        try:
            brief = await api_client.ask(caller, None)
        except Exception:
            log.exception("could not open the incoming call")
        voice = brief.get("voice") or VOICE
        pace = float(brief.get("pace") or VOICE_PACE)

        session = AgentSession(
            stt=make_stt(),
            llm=openai.LLM(model=LLM_MODEL),
            tts=sarvam.TTS(target_language_code="en-IN", model=VOICE_MODEL, speaker=voice, pace=pace),
            vad=ctx.proc.userdata["vad"],
            turn_handling=TURN_HANDLING,
        )
        watch_timing(session)
        agent = QuestionAgent(api_client, caller, brief)
        agent.forget_heard = search_early(session, lambda said: api_client.prepare(said, caller))
        await session.start(agent=agent, room=ctx.room)
        return

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
        stt=make_stt(),
        # Present because AgentSession expects one, and used only for phrasing.
        # It never decides the flow: every turn is intercepted before it speaks.
        llm=openai.LLM(model=LLM_MODEL),
        tts=sarvam.TTS(
            target_language_code="en-IN",
            model=VOICE_MODEL,
            speaker=voice,
            pace=pace,
        ),
        vad=ctx.proc.userdata["vad"],
        turn_handling=TURN_HANDLING,
    )
    watch_timing(session)
    answered = asyncio.Event()
    asyncio.ensure_future(wait_until_answered(ctx.room, answered))
    agent = AttendanceAgent(api_client, answered)
    agent.forget_heard = search_early(session, api_client.prepare)
    await session.start(agent=agent, room=ctx.room)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
