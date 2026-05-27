FROM nousresearch/hermes-agent:latest

USER root

RUN python -m pip install --no-cache-dir aiohttp

WORKDIR /opt/hermes-umbrel

COPY terminal_server.py ./
COPY public ./public

ENV HERMES_HOME=/opt/data
ENV HOME=/opt/data
ENV PYTHONUNBUFFERED=1

EXPOSE 9119

ENTRYPOINT []
CMD ["python", "/opt/hermes-umbrel/terminal_server.py"]
