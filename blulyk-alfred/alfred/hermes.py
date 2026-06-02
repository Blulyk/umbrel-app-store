import json
from collections.abc import AsyncIterator

import httpx


SYSTEM_PROMPT = """You are ALFRED: a precise, formal local systems steward.
Begin directly with status, data, or analysis. Avoid generic assistant pleasantries.
Use dry British restraint sparingly. Never invent tool results."""


class HermesClient:
    def __init__(self, base_url: str, model: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model

    async def stream_chat(
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
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None)) as client:
            async with client.stream("POST", f"{self.base_url}/chat/completions", json=payload) as resp:
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
