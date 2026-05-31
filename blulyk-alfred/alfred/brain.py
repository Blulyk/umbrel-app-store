from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from alfred.config import Settings
from alfred.memory import MemoryStore


SYSTEM_PROMPT = """You are JARVIS, Rafael's private intelligence layer inside umbrelOS.
You are calm, precise, technically capable, and direct.
You can reason over the provided local telemetry, but you must not invent tool results.
When the user writes in Spanish, answer in Spanish.
Keep answers useful, concise, and operational."""


class JarvisBrain:
    def __init__(self, settings: Settings, memory: MemoryStore) -> None:
        self.settings = settings
        self.memory = memory

    async def stream_chat(
        self, user_message: str, tool_context: dict[str, object]
    ) -> AsyncIterator[str]:
        api_key = await self._api_key()
        if not api_key:
            yield (
                "Mente OpenAI no configurada. Abre Sistemas > Mente OpenAI y guarda una API key; "
                "mientras tanto sigo operativo con reflejos locales."
            )
            return

        payload = {
            "model": await self._model(),
            "instructions": SYSTEM_PROMPT,
            "input": [
                {
                    "role": "developer",
                    "content": "Contexto local de JARVIS:\n"
                    + json.dumps(tool_context, ensure_ascii=False, indent=2),
                },
                {"role": "user", "content": user_message},
            ],
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        endpoint = self.settings.openai_base_url.rstrip("/")
        async with httpx.AsyncClient(timeout=httpx.Timeout(35.0, read=35.0)) as client:
            response = await client.post(f"{endpoint}/responses", json=payload, headers=headers)
            if response.status_code >= 400:
                yield self._error_message(response)
                return
            data = response.json()
            text = self._extract_output_text(data)
            yield text or "OpenAI no devolvio texto util."

    async def status(self) -> dict[str, Any]:
        configured = bool(await self._api_key())
        return {
            "state": "ready" if configured else "needs_key",
            "provider": "openai",
            "model": await self._model(),
            "base_url": self.settings.openai_base_url,
            "detail": "OpenAI conectado." if configured else "Falta configurar OPENAI_API_KEY.",
        }

    async def save_openai_key(self, api_key: str, model: str | None = None) -> None:
        await self.memory.set_preference("openai_api_key", api_key.strip())
        if model:
            await self.memory.set_preference("openai_model", model.strip())

    async def _api_key(self) -> str:
        saved = await self.memory.get_preference("openai_api_key")
        return str(saved or self.settings.openai_api_key or "").strip()

    async def _model(self) -> str:
        saved = await self.memory.get_preference("openai_model")
        return str(saved or self.settings.openai_model).strip()

    @staticmethod
    def _extract_output_text(data: dict[str, Any]) -> str:
        if data.get("output_text"):
            return str(data["output_text"]).strip()
        parts: list[str] = []
        for item in data.get("output", []):
            for content in item.get("content", []):
                if content.get("type") in {"output_text", "text"} and content.get("text"):
                    parts.append(str(content["text"]))
        return "\n".join(parts).strip()

    @staticmethod
    def _error_message(response: httpx.Response) -> str:
        try:
            payload = response.json()
            message = payload.get("error", {}).get("message")
            if message:
                return f"OpenAI rechazo la peticion: {message}"
        except ValueError:
            pass
        return f"OpenAI rechazo la peticion: HTTP {response.status_code}."
