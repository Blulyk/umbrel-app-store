from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import secrets
import tempfile
import time
import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from alfred.config import Settings
from alfred.memory import MemoryStore


DEFAULT_SYSTEM_PROMPT = """You are JARVIS, Rafael's private intelligence layer inside umbrelOS.
You are calm, precise, technically capable, and direct.
Use the provided local telemetry. Do not invent tool results.
When the user writes in Spanish, answer in Spanish.
Keep answers useful, concise, and operational."""


class JarvisBrain:
    def __init__(self, settings: Settings, memory: MemoryStore) -> None:
        self.settings = settings
        self.memory = memory
        self._codex_login_process: asyncio.subprocess.Process | None = None
        self._codex_login: dict[str, Any] | None = None
        self.system_prompt = _load_personality_prompt()

    async def stream_chat(
        self, user_message: str, tool_context: dict[str, object]
    ) -> AsyncIterator[str]:
        cached = await self._cache_get(user_message, tool_context)
        if cached:
            yield cached
            return

        codex_error = ""
        response = await self._ask_codex(user_message, tool_context)
        if response:
            if _is_cacheable_response(response):
                await self._cache_set(user_message, tool_context, response)
                yield response
                return
            codex_error = response

        response = await self._ask_google(user_message, tool_context)
        if response:
            if _is_cacheable_response(response):
                await self._cache_set(user_message, tool_context, response)
            yield response
            return

        if codex_error:
            yield codex_error
            return

        yield (
            "Mente externa no configurada. Conecta Codex con ChatGPT importando su auth.json en /data/codex/auth.json "
            "o configura Google Gemini como fallback en Sistemas > Google."
        )

    async def generate_widget_spec(self, user_prompt: str, tool_context: dict[str, object]) -> dict[str, Any]:
        prompt = (
            "Devuelve solo JSON valido para crear un widget del dashboard JARVIS. "
            "Schema: {\"type\":\"chat|metrics|config|logs|assets|self|terminal|custom\","
            "\"title\":\"max 34 chars\",\"description\":\"max 140 chars\","
            "\"query\":\"orden breve\",\"refreshSeconds\":0|10|30|60}. "
            "Elige tipos funcionales existentes cuando encajen. Usa self para control de JARVIS, "
            "terminal para comandos de sistema, custom para informacion general. Sin markdown.\n\n"
            f"Contexto: {json.dumps(_tiny_context(tool_context), ensure_ascii=False)}\n"
            f"Solicitud: {user_prompt}"
        )
        response = await self._ask_codex(prompt, {})
        if not response:
            response = await self._ask_google(prompt, {})
        return _coerce_widget_spec(response, user_prompt)

    async def status(self) -> dict[str, Any]:
        google_key = bool(await self._google_key())
        google_last_status = await self.memory.get_preference("google_last_status")
        google_state = "needs_key"
        google_detail = "Falta GOOGLE_API_KEY."
        if google_key:
            google_state = "configured"
            google_detail = "Google Gemini configurado; ejecuta Probar Gemini para validar permisos."
        if isinstance(google_last_status, dict) and google_key:
            google_state = "ready" if google_last_status.get("ok") else "error"
            google_detail = str(google_last_status.get("detail") or google_detail)
        codex_status = await self._codex_status()
        return {
            "primary": codex_status,
            "fallback": {
                "provider": "google-gemini",
                "state": google_state,
                "model": await self._google_model(),
                "detail": google_detail,
            },
            "optimization": {
                "local_reflex_first": True,
                "compact_context": True,
                "response_cache": True,
                "codex_sandbox": "read-only",
                "codex_timeout_seconds": self.settings.codex_timeout_seconds,
                "google_max_output_tokens": 700,
                "docker_control": self.settings.docker_control,
                "system_control": self.settings.system_control,
            },
        }

    async def save_google_key(self, api_key: str, model: str | None = None) -> None:
        await self.memory.set_preference("google_api_key", api_key.strip())
        if model:
            await self.memory.set_preference("google_model", model.strip())
        await self.memory.set_preference("google_last_status", {"ok": False, "detail": "Pendiente de prueba."})
        await self._clear_response_cache()

    async def test_google(self) -> dict[str, Any]:
        response = await self._ask_google("Responde exactamente: Gemini conectado.", {})
        ok = bool(response) and not response.startswith("Google Gemini rechazo") and not response.startswith("No he podido contactar")
        await self.memory.set_preference(
            "google_last_status",
            {
                "ok": ok,
                "detail": "Google Gemini fallback conectado." if ok else response or "Google Gemini no esta configurado.",
                "tested_at": int(time.time()),
            },
        )
        return {
            "ok": ok,
            "response": response or "Google Gemini no esta configurado.",
            "brain": await self.status(),
        }

    async def save_chatgpt_oauth(self, payload: dict[str, Any]) -> None:
        await self.memory.set_preference("chatgpt_oauth_config", payload)

    async def save_codex_auth(self, auth_json: str) -> None:
        payload = json.loads(auth_json)
        if not isinstance(payload, dict) or payload.get("auth_mode") != "chatgpt" or not isinstance(payload.get("tokens"), dict):
            raise ValueError("auth.json de Codex invalido.")
        codex_home = Path(self.settings.codex_home)
        codex_home.mkdir(parents=True, exist_ok=True)
        auth_path = codex_home / "auth.json"
        auth_path.write_text(json.dumps(payload), encoding="utf-8")
        try:
            auth_path.chmod(0o600)
        except OSError:
            pass
        await self._clear_response_cache()

    async def start_codex_device_login(self) -> dict[str, Any]:
        if Path(self.settings.codex_home, "auth.json").exists():
            return {"state": "connected", "brain": await self.status()}
        existing = self._codex_login_process
        if existing and existing.returncode is None:
            existing.terminate()
            try:
                await asyncio.wait_for(existing.wait(), timeout=4)
            except asyncio.TimeoutError:
                existing.kill()
        codex_home = Path(self.settings.codex_home)
        codex_home.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["CODEX_HOME"] = self.settings.codex_home
        try:
            process = await asyncio.create_subprocess_exec(
                self.settings.codex_bin,
                "login",
                "--device-auth",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd="/tmp",
            )
        except OSError as exc:
            return {
                "state": "failed",
                "detail": f"No he podido iniciar Codex CLI: {exc}",
            }
        self._codex_login_process = process
        output = ""
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if process.stdout is None:
                break
            try:
                chunk = await asyncio.wait_for(process.stdout.read(256), timeout=1)
            except asyncio.TimeoutError:
                continue
            if not chunk:
                break
            output += chunk.decode(errors="replace")
            parsed = _parse_codex_device_auth(output)
            if parsed:
                self._codex_login = {
                    **parsed,
                    "state": "waiting_for_browser",
                    "started_at": int(time.time()),
                    "expires_in_seconds": 900,
                }
                asyncio.create_task(self._watch_codex_login(process))
                return self._codex_login
        if process.returncode is None:
            process.terminate()
        return {
            "state": "failed",
            "detail": "Codex no devolvio enlace de autenticacion. Revisa que Codex CLI este instalado.",
        }

    async def codex_login_status(self) -> dict[str, Any]:
        login = self._codex_login or {"state": "idle"}
        process = self._codex_login_process
        if process and process.returncode is None and login.get("state") == "waiting_for_browser":
            return login
        if Path(self.settings.codex_home, "auth.json").exists():
            return {"state": "connected", "brain": await self.status()}
        return login

    async def _watch_codex_login(self, process: asyncio.subprocess.Process) -> None:
        try:
            await asyncio.wait_for(process.wait(), timeout=920)
        except asyncio.TimeoutError:
            process.kill()
            self._codex_login = {"state": "expired", "detail": "El codigo de Codex ha caducado."}
            return
        if Path(self.settings.codex_home, "auth.json").exists() and process.returncode == 0:
            self._codex_login = {"state": "connected", "detail": "Codex conectado con OpenAI."}
            await self._clear_response_cache()
        elif process.returncode != 0:
            self._codex_login = {"state": "failed", "detail": "Codex no pudo completar el inicio de sesion."}

    async def _ask_codex(self, user_message: str, tool_context: dict[str, object]) -> str:
        status = await self._codex_status()
        if status["state"] != "ready":
            return ""

        compact_context = _compact_context(tool_context)
        prompt = (
            f"{self.system_prompt}\n\n"
            "Responde solo con la respuesta final para Rafael. No incluyas trazas, comandos, JSONL, logs, "
            "marcadores de terminal ni explicaciones sobre Codex. Se conciso: maximo 6 lineas salvo que Rafael pida detalle. "
            "Si falta informacion, dilo de forma breve.\n\n"
            "Contexto local compacto:\n"
            + json.dumps(compact_context, ensure_ascii=False)
            + "\n\nPeticion:\n"
            + user_message
        )

        with tempfile.TemporaryDirectory(prefix="jarvis-codex-") as temp_dir:
            output_path = Path(temp_dir) / "final.txt"
            command = [
                self.settings.codex_bin,
                "--ask-for-approval",
                "never",
                "exec",
                "--skip-git-repo-check",
                "--ephemeral",
                "--ignore-rules",
                "--sandbox",
                "read-only",
                "--output-last-message",
                str(output_path),
                "-",
            ]
            if self.settings.codex_model:
                command[command.index("--output-last-message"):command.index("--output-last-message")] = [
                    "--model",
                    self.settings.codex_model,
                ]
            env = os.environ.copy()
            env["CODEX_HOME"] = self.settings.codex_home
            env.setdefault("HOME", "/data")
            try:
                process = await asyncio.create_subprocess_exec(
                    *command,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                    cwd="/tmp",
                )
                _, stderr = await asyncio.wait_for(
                    process.communicate(prompt.encode()),
                    timeout=self.settings.codex_timeout_seconds,
                )
            except (OSError, asyncio.TimeoutError):
                return ""
            if process.returncode != 0:
                return _codex_error_message(stderr.decode(errors="replace"))
            try:
                return clean_assistant_text(output_path.read_text(encoding="utf-8"))
            except OSError:
                return ""

    async def _codex_status(self) -> dict[str, Any]:
        auth_path = Path(self.settings.codex_home) / "auth.json"
        codex_bin = shutil.which(self.settings.codex_bin) or self.settings.codex_bin
        auth_ready = auth_path.exists()
        binary_ready = bool(shutil.which(self.settings.codex_bin) or Path(self.settings.codex_bin).exists())
        if auth_ready and binary_ready:
            state = "ready"
            detail = "Codex CLI conectado con auth.json de ChatGPT."
        elif not binary_ready:
            state = "missing_binary"
            detail = "Codex CLI no esta instalado en el contenedor."
        else:
            state = "needs_auth"
            detail = "Falta /data/codex/auth.json. Importa el auth.json de Codex para usar Sign in with ChatGPT."
        return {
            "provider": "codex-chatgpt-oauth",
            "state": state,
            "model": self.settings.codex_model or "chatgpt-plan-default",
            "binary": codex_bin,
            "detail": detail,
        }

    async def _ask_google(self, user_message: str, tool_context: dict[str, object]) -> str:
        api_key = await self._google_key()
        if not api_key:
            return ""
        model = await self._google_model()
        compact_context = _compact_context(tool_context)
        payload = {
            "systemInstruction": {"parts": [{"text": self.system_prompt}]},
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
                "maxOutputTokens": 420,
            },
        }
        headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}
        fallback_models = [model, "gemini-2.0-flash-lite", "gemini-1.5-flash"]
        last_error = ""
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(24.0, read=24.0)) as client:
                for candidate_model in dict.fromkeys(item for item in fallback_models if item):
                    endpoint = f"{self.settings.google_base_url.rstrip('/')}/models/{candidate_model}:generateContent"
                    response = await client.post(endpoint, json=payload, headers=headers)
                    if response.status_code < 400:
                        if candidate_model != model:
                            await self.memory.set_preference("google_model", candidate_model)
                        return _extract_gemini_text(response.json())
                    last_error = _google_error_message(response)
                    if response.status_code not in {403, 404}:
                        break
        except httpx.HTTPError as exc:
            return f"No he podido contactar con Google Gemini: {exc}"
        return last_error

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
            state = "connected"
        elif config:
            state = "configured_waiting_connection"
        else:
            state = "not_configured"
        return {
            "provider": "chatgpt-oauth",
            "state": state,
            "detail": (
                "OAuth generico conectado."
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

    async def _clear_response_cache(self) -> None:
        await self.memory.set_preference("brain_response_cache", {})

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
            "sample": [{"name": item.get("name"), "status": item.get("status")} for item in containers[:5]],
        },
        "assets_count": len(context.get("assets", []) if isinstance(context.get("assets"), list) else []),
        "recent_incidents": [
            {"category": item.get("category"), "summary": item.get("summary")}
            for item in (context.get("recent_incidents", [])[:2] if isinstance(context.get("recent_incidents"), list) else [])
        ],
    }


def _tiny_context(context: dict[str, object]) -> dict[str, object]:
    vitals = context.get("vitals") if isinstance(context.get("vitals"), dict) else {}
    docker = context.get("docker") if isinstance(context.get("docker"), dict) else {}
    return {
        "system": vitals.get("status"),
        "cpu": vitals.get("cpu_percent"),
        "ram": vitals.get("ram_percent"),
        "docker_available": docker.get("available"),
        "containers": len(docker.get("containers", [])) if isinstance(docker.get("containers"), list) else 0,
    }


def _coerce_widget_spec(text: str, user_prompt: str) -> dict[str, Any]:
    allowed = {"chat", "metrics", "config", "logs", "assets", "self", "terminal", "custom"}
    payload: dict[str, Any] = {}
    if text:
        cleaned = text.strip()
        match = re.search(r"\{.*\}", cleaned, re.S)
        if match:
            cleaned = match.group(0)
        try:
            parsed = json.loads(cleaned)
            if isinstance(parsed, dict):
                payload = parsed
        except json.JSONDecodeError:
            payload = {}
    fallback_type = _infer_widget_type(user_prompt)
    widget_type = str(payload.get("type") or fallback_type).strip().lower()
    if widget_type not in allowed:
        widget_type = fallback_type
    title = str(payload.get("title") or _fallback_widget_title(user_prompt, widget_type)).strip()[:34]
    description = str(payload.get("description") or user_prompt).strip()[:140]
    query = str(payload.get("query") or user_prompt).strip()[:240]
    try:
        refresh = int(payload.get("refreshSeconds") or 0)
    except (TypeError, ValueError):
        refresh = 0
    return {
        "type": widget_type,
        "title": title or "Widget",
        "description": description,
        "query": query,
        "refreshSeconds": refresh if refresh in {0, 10, 30, 60} else 0,
    }


def _infer_widget_type(prompt: str) -> str:
    text = prompt.lower()
    if re.search(r"control|reinicia|actualiza|self|propio|ti mismo|jarvis", text):
        return "self"
    if re.search(r"comando|terminal|shell|sistema|host", text):
        return "terminal"
    if re.search(r"chat|habla|pregunta|asistente|jarvis", text):
        return "chat"
    if re.search(r"google|oauth|openai|codex|gemini|api|config", text):
        return "config"
    if re.search(r"log|incidente|memoria|evento", text):
        return "logs"
    if re.search(r"asset|remoto|pc|almacenamiento|storage|disco remoto", text):
        return "assets"
    if re.search(r"cpu|ram|docker|red|network|trafico|tráfico|metrica|métrica", text):
        return "metrics"
    return "custom"


def _fallback_widget_title(prompt: str, widget_type: str) -> str:
    defaults = {
        "chat": "JARVIS Chat",
        "metrics": "Core Metrics",
        "config": "Brain Link",
        "logs": "Operational Logs",
        "assets": "Remote Assets",
        "self": "JARVIS Control",
        "terminal": "Host Console",
        "custom": "Dynamic Widget",
    }
    if widget_type != "custom":
        return defaults[widget_type]
    return re.sub(r"[^\w\sáéíóúñ]", "", prompt, flags=re.I).strip()[:34] or "Dynamic Widget"


def _load_personality_prompt() -> str:
    candidates = [
        Path("/app/personality.md"),
        Path(__file__).resolve().parents[1] / "personality.md",
        Path(__file__).resolve().parent / "personality.md",
    ]
    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if text:
            return text
    return DEFAULT_SYSTEM_PROMPT


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


def _parse_codex_device_auth(text: str) -> dict[str, str] | None:
    clean = _strip_ansi(text)
    url = re.search(r"https://auth\.openai\.com/codex/device", clean)
    code = re.search(r"\b[A-Z0-9]{4}-[A-Z0-9]{5}\b", clean)
    if not url or not code:
        return None
    return {
        "url": url.group(0),
        "code": code.group(0),
    }


def _strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", text)


def clean_assistant_text(text: str) -> str:
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not _is_terminal_noise(stripped):
            lines.append(stripped)
    return "\n".join(lines).strip()


def _is_terminal_noise(line: str) -> bool:
    lower = line.lower()
    if line in {">", "$", "❯"}:
        return True
    if all(char in "-_|+=~: .[]()0123456789" for char in line) and len(line) >= 12:
        return True
    fragments = [
        "msg=interrupt",
        "/queue",
        "/bg",
        "/steer",
        "ctrl+c",
        "tokens",
        "private telemetry",
        "current local telemetry",
        "codex exec",
    ]
    return any(fragment in lower for fragment in fragments)


def _is_cacheable_response(response: str) -> bool:
    prefixes = [
        "Google Gemini rechazo",
        "No he podido contactar",
        "Codex no pudo",
        "Codex necesita",
        "Mente externa no configurada",
    ]
    return bool(response.strip()) and not any(response.startswith(prefix) for prefix in prefixes)


def _codex_error_message(stderr: str) -> str:
    lower = stderr.lower()
    if "auth" in lower or "login" in lower:
        return "Codex necesita autenticacion. Importa el auth.json de Codex en /data/codex/auth.json."
    if "model" in lower:
        return "Codex no pudo usar el modelo configurado. Deja JARVIS_CODEX_MODEL vacio para usar el modelo por defecto de tu plan ChatGPT."
    return "Codex no pudo devolver una respuesta final; uso Gemini si esta configurado."


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
