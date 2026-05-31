from __future__ import annotations

import hashlib
import json
import secrets
import time
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlencode

import httpx

from alfred.config import Settings
from alfred.memory import MemoryStore


SYSTEM_PROMPT = """You are JARVIS, Rafael's private intelligence layer inside umbrelOS.
You are calm, precise, technically capable, and direct.
Use the provided local telemetry. Do not invent tool results.
When the user writes in Spanish, answer in Spanish.
Keep answers useful, concise, and operational."""


class JarvisBrain:
    def __init__(self, settings: Settings, memory: MemoryStore) -> None:
        self.settings = settings
        self.memory = memory

    async def stream_chat(
        self, user_message: str, tool_context: dict[str, object]
    ) -> AsyncIterator[str]:
        cached = await self._cache_get(user_message, tool_context)
        if cached:
            yield cached
            return

        response = await self._ask_google(user_message, tool_context)
        if response:
            if not response.startswith("Google Gemini rechazo") and not response.startswith("No he podido contactar"):
                await self._cache_set(user_message, tool_context, response)
            yield response
            return

        yield (
            "Mente externa no configurada. Conecta Google Gemini como fallback en Sistemas > Google, "
            "y deja ChatGPT OAuth preparado cuando OpenAI publique un flujo de inferencia por OAuth para suscripciones."
        )

    async def status(self) -> dict[str, Any]:
        google_key = bool(await self._google_key())
        chatgpt_oauth = await self._chatgpt_oauth_status()
        return {
            "primary": chatgpt_oauth,
            "fallback": {
                "provider": "google-gemini",
                "state": "ready" if google_key else "needs_key",
                "model": await self._google_model(),
                "detail": "Google Gemini fallback conectado." if google_key else "Falta GOOGLE_API_KEY.",
            },
            "optimization": {
                "local_reflex_first": True,
                "compact_context": True,
                "response_cache": True,
                "max_output_tokens": 700,
            },
        }

    async def save_google_key(self, api_key: str, model: str | None = None) -> None:
        await self.memory.set_preference("google_api_key", api_key.strip())
        if model:
            await self.memory.set_preference("google_model", model.strip())

    async def save_chatgpt_oauth(self, payload: dict[str, Any]) -> None:
        await self.memory.set_preference("chatgpt_oauth_config", payload)

    async def _ask_google(self, user_message: str, tool_context: dict[str, object]) -> str:
        api_key = await self._google_key()
        if not api_key:
            return ""
        model = await self._google_model()
        endpoint = f"{self.settings.google_base_url.rstrip('/')}/models/{model}:generateContent"
        compact_context = _compact_context(tool_context)
        payload = {
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "text": "Contexto local compacto:\n"
                            + json.dumps(compact_context, ensure_ascii=False)
                            + "\n\nPeticion:\n"
                            + user_message
                        }
                    ],
                }
            ],
            "generationConfig": {
                "temperature": 0.35,
                "topP": 0.85,
                "maxOutputTokens": 700,
            },
        }
        headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(24.0, read=24.0)) as client:
                response = await client.post(endpoint, json=payload, headers=headers)
                if response.status_code >= 400:
                    return _google_error_message(response)
                data = response.json()
        except httpx.HTTPError as exc:
            return f"No he podido contactar con Google Gemini: {exc}"
        return _extract_gemini_text(data)

    async def _google_key(self) -> str:
        saved = await self.memory.get_preference("google_api_key")
        return str(saved or self.settings.google_api_key or "").strip()

    async def _google_model(self) -> str:
        saved = await self.memory.get_preference("google_model")
        return str(saved or self.settings.google_model).strip()

    async def _chatgpt_oauth_status(self) -> dict[str, Any]:
        config = await self.memory.get_preference("chatgpt_oauth_config")
        token = await self.memory.get_preference("chatgpt_oauth_token")
        if token:
            state = "connected_waiting_official_inference"
        elif config:
            state = "configured_waiting_connection"
        else:
            state = "not_configured"
        return {
            "provider": "chatgpt-oauth",
            "state": state,
            "detail": (
                "OAuth conectado, pero ChatGPT no expone un endpoint oficial para usar la suscripcion como backend."
                if token
                else "OAuth config guardada. Abre la conexion desde Sistemas para completar el intercambio de codigo."
                if config
                else "Preparado para guardar cliente OAuth cuando haya un flujo oficial utilizable."
            ),
        }

    async def chatgpt_oauth_authorization_url(self, redirect_uri: str) -> str:
        config = await self._chatgpt_oauth_config()
        state = secrets.token_urlsafe(24)
        await self.memory.set_preference("chatgpt_oauth_state", state)
        params = {
            "response_type": "code",
            "client_id": config["client_id"],
            "redirect_uri": redirect_uri,
            "state": state,
        }
        if config.get("scope"):
            params["scope"] = config["scope"]
        return f"{config['authorization_url']}?{urlencode(params)}"

    async def complete_chatgpt_oauth(self, code: str, state: str, redirect_uri: str) -> dict[str, Any]:
        saved_state = await self.memory.get_preference("chatgpt_oauth_state")
        if not saved_state or saved_state != state:
            return {"ok": False, "error": "Estado OAuth invalido o caducado."}
        config = await self._chatgpt_oauth_config()
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": config["client_id"],
            "client_secret": config["client_secret"],
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, read=20.0)) as client:
            response = await client.post(config["token_url"], data=data, headers={"Accept": "application/json"})
        if response.status_code >= 400:
            return {"ok": False, "error": _oauth_error_message(response)}
        token = response.json()
        token["received_at"] = int(time.time())
        await self.memory.set_preference("chatgpt_oauth_token", token)
        await self.memory.set_preference("chatgpt_oauth_state", "")
        return {"ok": True, "status": await self._chatgpt_oauth_status()}

    async def _cache_get(self, user_message: str, tool_context: dict[str, object]) -> str:
        cache = await self.memory.get_preference("brain_response_cache") or {}
        item = cache.get(_cache_key(user_message, tool_context))
        return str(item or "")

    async def _cache_set(self, user_message: str, tool_context: dict[str, object], response: str) -> None:
        cache = await self.memory.get_preference("brain_response_cache") or {}
        cache[_cache_key(user_message, tool_context)] = response
        if len(cache) > 50:
            cache = dict(list(cache.items())[-50:])
        await self.memory.set_preference("brain_response_cache", cache)

    async def _chatgpt_oauth_config(self) -> dict[str, str]:
        config = await self.memory.get_preference("chatgpt_oauth_config")
        if not isinstance(config, dict):
            raise ValueError("OAuth de ChatGPT no configurado.")
        required = ["client_id", "client_secret", "authorization_url", "token_url"]
        missing = [key for key in required if not str(config.get(key) or "").strip()]
        if missing:
            raise ValueError(f"OAuth incompleto: {', '.join(missing)}.")
        return {key: str(config.get(key) or "").strip() for key in [*required, "scope"]}


def _compact_context(context: dict[str, object]) -> dict[str, object]:
    docker = context.get("docker") if isinstance(context.get("docker"), dict) else {}
    containers = docker.get("containers", []) if isinstance(docker, dict) else []
    return {
        "vitals": context.get("vitals"),
        "threats": context.get("threats"),
        "docker": {
            "available": docker.get("available") if isinstance(docker, dict) else False,
            "running": sum(1 for item in containers if item.get("status") == "running"),
            "total": len(containers),
            "sample": containers[:8],
        },
        "assets_count": len(context.get("assets", []) if isinstance(context.get("assets"), list) else []),
        "recent_incidents": context.get("recent_incidents", [])[:3] if isinstance(context.get("recent_incidents"), list) else [],
    }


def _cache_key(user_message: str, context: dict[str, object]) -> str:
    vitals = context.get("vitals") if isinstance(context.get("vitals"), dict) else {}
    status = {
        "message": " ".join(user_message.lower().split()),
        "vitals_status": vitals.get("status") if isinstance(vitals, dict) else "",
    }
    return hashlib.sha256(json.dumps(status, sort_keys=True).encode()).hexdigest()


def _extract_gemini_text(data: dict[str, Any]) -> str:
    parts: list[str] = []
    for candidate in data.get("candidates", []):
        content = candidate.get("content", {})
        for part in content.get("parts", []):
            if part.get("text"):
                parts.append(str(part["text"]))
    return "\n".join(parts).strip()


def _google_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
        message = payload.get("error", {}).get("message")
        if message:
            return f"Google Gemini rechazo la peticion: {message}"
    except ValueError:
        pass
    return f"Google Gemini rechazo la peticion: HTTP {response.status_code}."


def _oauth_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
        return str(payload.get("error_description") or payload.get("error") or f"HTTP {response.status_code}")
    except ValueError:
        return f"HTTP {response.status_code}"
