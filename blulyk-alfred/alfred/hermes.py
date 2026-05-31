from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from urllib.parse import urlparse, urlunparse

import httpx
import websockets


SYSTEM_PROMPT = """You are ALFRED: a precise, formal local systems steward.
You are the user's private operations intelligence, with Hermes Agent as your reasoning core.
Begin directly with status, data, or analysis. Avoid generic assistant pleasantries.
Speak in clear Spanish when the user writes in Spanish. Never invent tool results."""

ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")
TERMINAL_RULE_CHARS = set("-_|+=~: .[]()0123456789")
PROMPT_MARKERS = (">", "$", "\u276f")


class HermesClient:
    def __init__(self, base_url: str, model: str, api_key: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key

    async def stream_chat(
        self, user_message: str, tool_context: dict[str, object]
    ) -> AsyncIterator[str]:
        try:
            async for chunk in self._stream_openai_chat(user_message, tool_context):
                yield chunk
            return
        except Exception:
            async for chunk in self._stream_terminal_chat(user_message):
                yield chunk

    async def _stream_openai_chat(
        self, user_message: str, tool_context: dict[str, object]
    ) -> AsyncIterator[str]:
        payload = {
            "model": self.model,
            "stream": True,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "system",
                    "content": "Current local telemetry:\n"
                    + json.dumps(tool_context, ensure_ascii=False, indent=2),
                },
                {"role": "user", "content": user_message},
            ],
        }
        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        endpoint = self.base_url
        if not endpoint.endswith("/v1"):
            endpoint = f"{endpoint}/v1"

        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None)) as client:
            async with client.stream("POST", f"{endpoint}/chat/completions", json=payload, headers=headers) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line.removeprefix("data: ").strip()
                    if data == "[DONE]":
                        break
                    chunk = json.loads(data)
                    delta = chunk["choices"][0].get("delta", {})
                    content = delta.get("content")
                    if content:
                        yield content

    async def _stream_terminal_chat(self, user_message: str) -> AsyncIterator[str]:
        safe_message = " ".join(user_message.split())
        if not safe_message:
            return

        async with websockets.connect(self._terminal_ws_url(), open_timeout=10, close_timeout=2) as websocket:
            await self._drain_initial_terminal(websocket)
            await websocket.send(json.dumps({"type": "input", "data": safe_message + "\n"}))
            response = await self._collect_terminal_response(websocket, safe_message)

        if response:
            yield response

    def _terminal_ws_url(self) -> str:
        parsed = urlparse(self.base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        path = parsed.path.rstrip("/")
        if path.endswith("/v1"):
            path = path[:-3]
        return urlunparse((scheme, parsed.netloc, f"{path}/ws", "", "mode=chat", ""))

    async def _drain_initial_terminal(self, websocket: websockets.ClientConnection) -> None:
        quiet_rounds = 0
        while quiet_rounds < 4:
            try:
                await asyncio.wait_for(websocket.recv(), timeout=0.25)
                quiet_rounds = 0
            except TimeoutError:
                quiet_rounds += 1

    async def _collect_terminal_response(self, websocket: websockets.ClientConnection, prompt: str) -> str:
        chunks: list[str] = []
        saw_output = False
        idle_rounds = 0
        for _ in range(100):
            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=0.5)
            except TimeoutError:
                if saw_output:
                    idle_rounds += 1
                    if idle_rounds >= 5:
                        break
                continue

            text = message.decode(errors="replace") if isinstance(message, bytes) else str(message)
            clean = _clean_terminal_text(text)
            if clean:
                saw_output = True
                idle_rounds = 0
                chunks.append(clean)

        return _extract_answer("".join(chunks), prompt)


def _clean_terminal_text(value: str) -> str:
    clean = ANSI_RE.sub("", value).replace("\r", "")
    clean = clean.replace("\u2500", "-").replace("\u2502", "|")
    return clean


def _extract_answer(raw: str, prompt: str) -> str:
    text = raw
    prompt_index = text.find(prompt)
    if prompt_index >= 0:
        text = text[prompt_index + len(prompt) :]

    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            if lines and lines[-1]:
                lines.append("")
            continue
        if _is_terminal_noise(stripped):
            continue
        lines.append(stripped)
    return "\n".join(lines).strip()


def _is_terminal_noise(line: str) -> bool:
    lower = line.lower()
    if line in PROMPT_MARKERS:
        return True
    if "$ hermes" in lower or lower in {"hermes", "- $ hermes", "-- $ hermes"}:
        return True
    if _mostly_rule(line):
        return True

    noise_fragments = [
        "gpt-",
        "msg=interrupt",
        "/queue",
        "/bg",
        "/steer",
        "ctrl+c",
        "reflecting",
        "tokens",
        "alfred context follows",
        "private telemetry",
        "current local telemetry",
        "context:",
        "user request:",
    ]
    return any(fragment in lower for fragment in noise_fragments)


def _mostly_rule(line: str) -> bool:
    if len(line) < 12:
        return False
    simple = "".join(char for char in line if ord(char) < 128)
    if not simple:
        return True
    return sum(1 for char in simple if char in TERMINAL_RULE_CHARS) / len(simple) > 0.65
