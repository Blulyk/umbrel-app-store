from __future__ import annotations

import base64
import hashlib
import secrets
import time
from typing import Any
from urllib.parse import urlencode

import httpx

from alfred.config import Settings
from alfred.memory import MemoryStore


GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"


class GoogleOAuthController:
    def __init__(self, settings: Settings, memory: MemoryStore) -> None:
        self.settings = settings
        self.memory = memory

    async def status(self) -> dict[str, Any]:
        token = await self.memory.get_preference("google_oauth_token")
        configured = self._configured()
        return {
            "configured": configured,
            "connected": bool(token),
            "client_id": _mask_client_id(self.settings.google_oauth_client_id),
            "redirect_uri": self.settings.google_oauth_redirect_uri,
            "scopes": self.settings.google_oauth_scopes,
            "detail": (
                "Google OAuth conectado."
                if token
                else "Faltan GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET."
                if not configured
                else "Cliente OAuth configurado; inicia la autorizacion."
            ),
        }

    async def authorization_url(self) -> str:
        if not self._configured():
            raise ValueError("Configura GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET en el entorno.")
        state = secrets.token_urlsafe(32)
        verifier = _token_urlsafe(48)
        challenge = _pkce_challenge(verifier)
        pending = {
            "state": state,
            "code_verifier": verifier,
            "created_at": int(time.time()),
            "redirect_uri": self.settings.google_oauth_redirect_uri,
        }
        await self.memory.set_preference(f"google_oauth_pending:{state}", pending)
        params = {
            "client_id": self.settings.google_oauth_client_id,
            "redirect_uri": self.settings.google_oauth_redirect_uri,
            "response_type": "code",
            "scope": self.settings.google_oauth_scopes,
            "access_type": "offline",
            "include_granted_scopes": "true",
            "prompt": "consent",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
        return f"{GOOGLE_AUTH_URL}?{urlencode(params)}"

    async def callback(self, code: str, state: str) -> dict[str, Any]:
        pending = await self.memory.get_preference(f"google_oauth_pending:{state}")
        if not isinstance(pending, dict) or pending.get("state") != state:
            return {"ok": False, "error": "Estado OAuth invalido o caducado."}
        created_at = int(pending.get("created_at") or 0)
        if created_at and time.time() - created_at > 900:
            await self.memory.set_preference(f"google_oauth_pending:{state}", {})
            return {"ok": False, "error": "Estado OAuth caducado. Inicia sesion de nuevo."}
        data = {
            "client_id": self.settings.google_oauth_client_id,
            "client_secret": self.settings.google_oauth_client_secret,
            "code": code,
            "code_verifier": pending["code_verifier"],
            "grant_type": "authorization_code",
            "redirect_uri": pending["redirect_uri"],
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, read=20.0)) as client:
            response = await client.post(GOOGLE_TOKEN_URL, data=data, headers={"Accept": "application/json"})
        if response.status_code >= 400:
            return {"ok": False, "error": _oauth_error(response)}
        token = response.json()
        token["received_at"] = int(time.time())
        await self.memory.set_preference("google_oauth_token", token)
        await self.memory.set_preference(f"google_oauth_pending:{state}", {})
        return {"ok": True, "status": await self.status()}

    async def refresh(self) -> dict[str, Any]:
        token = await self.memory.get_preference("google_oauth_token")
        if not isinstance(token, dict) or not token.get("refresh_token"):
            return {"ok": False, "error": "No hay refresh_token guardado."}
        data = {
            "client_id": self.settings.google_oauth_client_id,
            "client_secret": self.settings.google_oauth_client_secret,
            "refresh_token": token["refresh_token"],
            "grant_type": "refresh_token",
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, read=20.0)) as client:
            response = await client.post(GOOGLE_TOKEN_URL, data=data, headers={"Accept": "application/json"})
        if response.status_code >= 400:
            return {"ok": False, "error": _oauth_error(response)}
        refreshed = response.json()
        refreshed["refresh_token"] = refreshed.get("refresh_token") or token.get("refresh_token")
        refreshed["received_at"] = int(time.time())
        await self.memory.set_preference("google_oauth_token", refreshed)
        return {"ok": True, "status": await self.status()}

    async def disconnect(self) -> dict[str, Any]:
        token = await self.memory.get_preference("google_oauth_token")
        access_token = token.get("access_token") if isinstance(token, dict) else None
        if access_token:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(GOOGLE_REVOKE_URL, params={"token": access_token})
        await self.memory.set_preference("google_oauth_token", {})
        return {"ok": True, "status": await self.status()}

    def _configured(self) -> bool:
        return bool(self.settings.google_oauth_client_id and self.settings.google_oauth_client_secret)


def _token_urlsafe(byte_count: int) -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(byte_count)).decode().rstrip("=")


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def _mask_client_id(value: str | None) -> str:
    if not value:
        return ""
    if len(value) <= 12:
        return "***"
    return f"{value[:6]}...{value[-6:]}"


def _oauth_error(response: httpx.Response) -> str:
    try:
        payload = response.json()
        return str(payload.get("error_description") or payload.get("error") or f"HTTP {response.status_code}")
    except ValueError:
        return f"HTTP {response.status_code}"
