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
    fontconfig \
    file \
    fonts-dejavu-core \
    fonts-noto-core \
    fonts-noto-color-emoji \
    libmagic1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG ODYSSEUS_REPO=https://github.com/pewdiepie-archdaemon/odysseus.git
ARG ODYSSEUS_REF=main

RUN git clone --depth 1 --branch "${ODYSSEUS_REF}" "${ODYSSEUS_REPO}" /tmp/odysseus \
  && cp -a /tmp/odysseus/. /app/ \
  && rm -rf /tmp/odysseus /app/.git

COPY umbrel-auth-bypass.py /tmp/umbrel-auth-bypass.py
RUN python /tmp/umbrel-auth-bypass.py \
  && rm /tmp/umbrel-auth-bypass.py

COPY umbrel-runtime-patches.py /tmp/umbrel-runtime-patches.py
RUN python /tmp/umbrel-runtime-patches.py \
  && rm /tmp/umbrel-runtime-patches.py \
  && fc-cache -f

RUN pip install --no-cache-dir -r requirements.txt \
  && pip install --no-cache-dir \
    PyMuPDF \
    python-magic \
    python-docx \
    mammoth \
    pdfplumber

RUN mkdir -p data logs services/cache/search \
  && chmod +x docker/entrypoint.sh \
  && cp docker/entrypoint.sh /usr/local/bin/entrypoint.sh

EXPOSE 7000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7000"]
