# The talking attendance agent

A LiveKit worker that holds the attendance conversation out loud, for employees
set to **Call (conversation)** rather than **Call (keypad)**.

It is deliberately thin. Every decision — what to ask, what an answer means,
which date comes next, when the call is over — is made by the platform's turn
API (`POST /api/agent/turn`), which is the same code the keypad calls run on.
The worker only listens, speaks, and passes what it heard along. That is why a
date answered on a talking call and the same date answered on a keypad call
leave the database in exactly the same state.

## Running it

    cd agent
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env     # fill in, or point at the project's own .env
    python worker.py dev

The worker waits for rooms named `attendance-call-<call id>`. The platform
creates one and dials the employee into it whenever it places a call.

## What it needs

| Variable | Why |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | to join rooms |
| `APP_BASE_URL` | where the turn API lives |
| `AGENT_API_TOKEN` | shared secret for the turn API |
| `OPENAI_API_KEY` | listening, deciding how to phrase, speaking |
