FROM nousresearch/hermes-agent:latest

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3-aiohttp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/hermes-umbrel

COPY terminal_server.py ./
COPY hotfix_codex.py ./
COPY public ./public

RUN python3 /opt/hermes-umbrel/hotfix_codex.py

ENV HERMES_HOME=/opt/data
ENV HOME=/opt/data
ENV PYTHONUNBUFFERED=1

EXPOSE 9119

CMD ["python3", "/opt/hermes-umbrel/terminal_server.py"]
