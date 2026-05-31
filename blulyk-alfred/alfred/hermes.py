from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import time
from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from pathlib import Path
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
CURSOR_POSITION_REQUEST = "\x1b[6n"
CURSOR_POSITION_RESPONSE = "\x1b[32;1R"
HERMES_LIMIT_MESSAGE = "Hermes no puede responder ahora: limite de uso del proveedor alcanzado."
HERMES_EMPTY_MESSAGE = "Hermes recibio la orden, pero no devolvio una respuesta final."
TERMINAL_MODE = "alfred"
_RECENT_FAILURE_WINDOW = timedelta(minutes=30)


class HermesClient:
    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str | None = None,
        state_db_path: str | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.state_db_path = state_db_path

    async def stream_chat(
        self, user_message: str, tool_context: dict[str, object]
    ) -> AsyncIterator[str]:
        status_message = await asyncio.to_thread(self._current_hermes_status_message)
        if status_message:
            yield status_message
            return

        try:
            emitted = False
            async for chunk in self._stream_openai_chat(user_message, tool_context):
                emitted = True
                yield chunk
            if not emitted:
                yield HERMES_EMPTY_MESSAGE
            return
        except Exception:
            emitted = False
            async for chunk in self._stream_terminal_chat(user_message):
                emitted = True
                yield chunk
            if not emitted:
                yield self._hermes_failure_message(0) or HERMES_EMPTY_MESSAGE

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

        before_id = await asyncio.to_thread(self._latest_message_id)
        log_offset = await asyncio.to_thread(self._agent_log_offset)
        await self._restart_terminal_session()
        async with websockets.connect(
            self._terminal_ws_url(),
            open_timeout=10,
            close_timeout=2,
            ping_interval=None,
        ) as websocket:
            await self._cancel_active_terminal_turn(websocket)
            await self._drain_initial_terminal(websocket)
            await websocket.send(json.dumps({"type": "input", "data": safe_message + "\n"}))
            response = await self._wait_for_stored_response(safe_message, before_id, log_offset)
            if not response:
                response = await self._collect_terminal_response(websocket, safe_message)
            if not response:
                response = self._hermes_failure_message(log_offset)

        if response:
            yield response

    def _terminal_ws_url(self) -> str:
        parsed = urlparse(self.base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        path = parsed.path.rstrip("/")
        if path.endswith("/v1"):
            path = path[:-3]
        return urlunparse((scheme, parsed.netloc, f"{path}/ws", "", f"mode={TERMINAL_MODE}", ""))

    async def _restart_terminal_session(self) -> None:
        endpoint = self.base_url
        if endpoint.endswith("/v1"):
            endpoint = endpoint[:-3]
        async with httpx.AsyncClient(timeout=5) as client:
            try:
                await client.post(f"{endpoint}/session/restart", params={"mode": TERMINAL_MODE})
            except httpx.HTTPError:
                pass

    async def _drain_initial_terminal(self, websocket: websockets.ClientConnection) -> None:
        quiet_rounds = 0
        while quiet_rounds < 4:
            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=0.25)
                await self._answer_terminal_queries(websocket, message)
                quiet_rounds = 0
            except TimeoutError:
                quiet_rounds += 1

    async def _cancel_active_terminal_turn(self, websocket: websockets.ClientConnection) -> None:
        await websocket.send(json.dumps({"type": "input", "data": "\u0003"}))
        await asyncio.sleep(0.25)

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
            await self._answer_terminal_queries(websocket, text)
            clean = _clean_terminal_text(text)
            if clean:
                saw_output = True
                idle_rounds = 0
                chunks.append(clean)

        return _extract_answer("".join(chunks), prompt)

    async def _answer_terminal_queries(self, websocket: websockets.ClientConnection, message: object) -> None:
        text = message.decode(errors="replace") if isinstance(message, bytes) else str(message)
        if CURSOR_POSITION_REQUEST in text:
            await websocket.send(json.dumps({"type": "input", "data": CURSOR_POSITION_RESPONSE}))

    def _latest_message_id(self) -> int:
        db_path = self._state_db_path()
        if not db_path:
            return 0
        try:
            with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1) as connection:
                row = connection.execute("select coalesce(max(id), 0) from messages").fetchone()
                return int(row[0] or 0)
        except sqlite3.Error:
            return 0

    async def _wait_for_stored_response(self, prompt: str, after_id: int, log_offset: int) -> str:
        if not self._state_db_path():
            return ""

        deadline = time.monotonic() + 90
        user_message_id = 0
        session_id = ""
        while time.monotonic() < deadline:
            result = await asyncio.to_thread(self._stored_response, prompt, after_id, user_message_id, session_id)
            if result["content"]:
                return result["content"]
            user_message_id = result["user_message_id"]
            session_id = result["session_id"]
            failure = await asyncio.to_thread(self._hermes_failure_message, log_offset)
            if failure:
                return failure
            await asyncio.sleep(0.5)
        return ""

    def _stored_response(self, prompt: str, after_id: int, user_message_id: int, session_id: str) -> dict[str, object]:
        db_path = self._state_db_path()
        if not db_path:
            return {"content": "", "user_message_id": user_message_id, "session_id": session_id}

        try:
            with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1) as connection:
                connection.row_factory = sqlite3.Row
                if not user_message_id:
                    user_row = connection.execute(
                        """
                        select id, session_id
                        from messages
                        where role = 'user' and content = ? and id > ?
                        order by id desc
                        limit 1
                        """,
                        (prompt, after_id),
                    ).fetchone()
                    if user_row is None:
                        return {"content": "", "user_message_id": 0, "session_id": ""}
                    user_message_id = int(user_row["id"])
                    session_id = str(user_row["session_id"])

                assistant_row = connection.execute(
                    """
                    select content
                    from messages
                    where role = 'assistant'
                      and session_id = ?
                      and id > ?
                      and content is not null
                      and trim(content) != ''
                    order by id asc
                    limit 1
                    """,
                    (session_id, user_message_id),
                ).fetchone()
                content = ""
                if assistant_row is not None:
                    content = clean_final_answer(str(assistant_row["content"]))
                return {"content": content, "user_message_id": user_message_id, "session_id": session_id}
        except sqlite3.Error:
            return {"content": "", "user_message_id": user_message_id, "session_id": session_id}

    def _state_db_path(self) -> str:
        if not self.state_db_path:
            return ""
        path = Path(self.state_db_path)
        if not path.exists():
            return ""
        return str(path)

    def _agent_log_path(self) -> Path | None:
        db_path = self._state_db_path()
        if not db_path:
            return None
        log_path = Path(db_path).parent / "logs" / "agent.log"
        return log_path if log_path.exists() else None

    def _agent_log_offset(self) -> int:
        log_path = self._agent_log_path()
        if not log_path:
            return 0
        try:
            return log_path.stat().st_size
        except OSError:
            return 0

    def _hermes_failure_message(self, log_offset: int) -> str:
        log_path = self._agent_log_path()
        if not log_path:
            return ""
        try:
            current_size = log_path.stat().st_size
            start = min(max(log_offset, 0), current_size)
            with log_path.open("rb") as handle:
                handle.seek(start)
                text = handle.read(64_000).decode(errors="replace")
        except OSError:
            return ""

        lower = text.lower()
        if "usage_limit_reached" in lower or "http 429" in lower or "usage limit has been reached" in lower:
            return HERMES_LIMIT_MESSAGE
        if "credential pool: no available entries" in lower:
            return HERMES_LIMIT_MESSAGE
        if "api call failed after" in lower:
            return HERMES_EMPTY_MESSAGE
        return ""

    def _current_hermes_status_message(self) -> str:
        log_path = self._agent_log_path()
        if not log_path:
            return ""
        try:
            with log_path.open("rb") as handle:
                handle.seek(max(log_path.stat().st_size - 64_000, 0))
                text = handle.read().decode(errors="replace")
        except OSError:
            return ""

        last_failure: datetime | None = None
        last_success: datetime | None = None
        for line in text.splitlines():
            timestamp = _line_timestamp(line)
            lower = line.lower()
            if "api call #" in lower or "turn ended: reason=text_response" in lower:
                last_success = timestamp or last_success
            if (
                "credential pool: no available entries" in lower
                or "usage_limit_reached" in lower
                or "http 429" in lower
                or "usage limit has been reached" in lower
            ):
                last_failure = timestamp or last_failure

        if last_failure and (not last_success or last_failure >= last_success):
            if datetime.now() - last_failure < _RECENT_FAILURE_WINDOW:
                return HERMES_LIMIT_MESSAGE
        return ""


def _clean_terminal_text(value: str) -> str:
    clean = ANSI_RE.sub("", value).replace("\r", "")
    clean = clean.replace("\u2500", "-").replace("\u2502", "|")
    return clean


def _line_timestamp(line: str) -> datetime | None:
    try:
        return datetime.strptime(line[:23], "%Y-%m-%d %H:%M:%S,%f")
    except ValueError:
        return None


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
    return clean_final_answer("\n".join(lines))


def clean_final_answer(value: str) -> str:
    return "\n".join(
        line.rstrip()
        for line in str(value).splitlines()
        if line.strip() and not _is_terminal_noise(line.strip())
    ).strip()


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
