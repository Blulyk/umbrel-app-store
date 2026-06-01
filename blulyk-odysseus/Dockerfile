FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    curl \
    git \
    nodejs \
    npm \
    tmux \
    openssh-client \
    gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG ODYSSEUS_REPO=https://github.com/pewdiepie-archdaemon/odysseus.git
ARG ODYSSEUS_REF=main

RUN git clone --depth 1 --branch "${ODYSSEUS_REF}" "${ODYSSEUS_REPO}" /tmp/odysseus \
  && cp -a /tmp/odysseus/. /app/ \
  && rm -rf /tmp/odysseus /app/.git

RUN pip install --no-cache-dir -r requirements.txt

RUN mkdir -p data logs services/cache/search \
  && chmod +x docker/entrypoint.sh \
  && cp docker/entrypoint.sh /usr/local/bin/entrypoint.sh

EXPOSE 7000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7000"]
