# The voice agent worker, as a container.
#
# It serves nothing. It dials out to LiveKit, waits to be given a room, and
# talks - so it runs with no ingress and needs no port. The model files are
# baked in at build time rather than fetched on boot, because a worker that
# downloads a VAD model while a call is already ringing is a worker that misses
# the call.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY worker.py ./

# Silero's VAD and the turn detector ship as weights, not as code.
RUN python worker.py download-files

CMD ["python", "worker.py", "start"]
