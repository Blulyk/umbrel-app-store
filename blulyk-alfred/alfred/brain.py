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
from alfred.widget_engine import WidgetManifest, manifest_from_intent, validate_manifest


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
            "Devuelve solo JSON valido para crear un widget funcional del dashboard JARVIS en tiempo real. "
            "Si Rafael pide una herramienta nueva, debes crear un live widget con HTML, CSS y JavaScript propios. "
            "No devuelvas tarjetas estaticas ni explicaciones. "
            "Schema base: {\"type\":\"chat|metrics|config|logs|assets|self|terminal|custom|live\","
            "\"title\":\"max 34 chars\",\"description\":\"max 140 chars\","
            "\"query\":\"orden breve\",\"refreshSeconds\":0|10|30|60,"
            "\"size\":{\"w\":300-980,\"h\":220-820},"
            "\"runtime\":{\"html\":\"markup interno sin scripts\",\"css\":\"css scoped\",\"js\":\"javascript sin fetch directo\"},"
            "\"custom\":{\"kind\":\"search|form|tool|assistant|monitor|notes\","
            "\"fields\":[{\"id\":\"texto_sin_espacios\",\"label\":\"max 24\",\"type\":\"text|search|number|textarea|select\",\"placeholder\":\"max 60\",\"options\":[\"opcional\"]}],"
            "\"actions\":[{\"id\":\"texto_sin_espacios\",\"label\":\"max 24\",\"type\":\"open_url|ask_jarvis|tool_call|show_value\","
            "\"urlTemplate\":\"https://www.google.com/search?q={campo}\","
            "\"promptTemplate\":\"texto con {campo}\",\"tool\":\"vitals.report\",\"arguments\":{}}],"
            "\"notes\":[\"linea breve\"]}}. "
            "Herramientas permitidas para tool_call: vitals.report, threats.scan, docker.summary, docker.restart, "
            "jarvis.self_status, jarvis.self_restart, system.host_shell, memory.incidents, asset.command. "
            "Para system.host_shell o reinicios incluye arguments.confirm=true solo si Rafael pide control operativo. "
            "En runtime.js usa exclusivamente la API disponible: await JARVIS.callTool(tool,args), await JARVIS.chat(message), "
            "await JARVIS.status(), JARVIS.openUrl(url), JARVIS.toast(text). "
            "Para 'buscador', 'calculadora', 'formulario', 'monitor personalizado', 'panel', 'botonera' o cualquier idea nueva "
            "usa type=live con runtime completo. Usa tipos existentes solo para paneles nativos ya definidos. Sin markdown.\n\n"
            f"Contexto: {json.dumps(_tiny_context(tool_context), ensure_ascii=False)}\n"
            f"Solicitud: {user_prompt}"
        )
        response = await self._ask_codex(prompt, {})
        if not response:
            response = await self._ask_google(prompt, {}, max_output_tokens=1800)
        return _coerce_widget_spec(response, user_prompt)

    async def generate_widget_manifest(
        self,
        user_prompt: str,
        tool_context: dict[str, object],
        next_index: int = 1,
    ) -> WidgetManifest:
        prompt = (
            "Devuelve solo JSON valido para un manifiesto declarativo de widget JARVIS. "
            "No generes HTML, CSS, JavaScript, runtime, scripts ni markdown si el usuario pide una herramienta funcional. "
            "El widget debe poder renderizarse con tipos seguros ya existentes.\n"
            "Tipos permitidos: status_card, metric_card, metric_grid, line_chart, bar_chart, table, log_viewer, "
            "markdown, checklist, form, image_preview, web_preview, command_panel, service_monitor, calendar_panel, "
            "file_panel, chat_panel, automation_panel, iframe_sandbox.\n"
            "Fuentes permitidas: static, mock, internal_tool, http_endpoint, local_storage, system_metric, manual_input.\n"
            "Herramientas internas permitidas: get_system_status, get_network_status, get_cpu_ram_status, "
            "get_storage_status, get_recent_logs, get_service_status, get_calendar_preview, get_assets_list, "
            "sync_workspace, restart_service.\n"
            "Schema minimo: {"
            "\"type\":\"form|metric_grid|table|...\","
            "\"title\":\"max 80\","
            "\"description\":\"max 240\","
            "\"refreshInterval\":0,"
            "\"dataSource\":{\"type\":\"manual_input|internal_tool|static\",\"toolName\":null,\"params\":{}},"
            "\"config\":{},"
            "\"actions\":[{\"id\":\"texto\",\"label\":\"max 80\",\"toolName\":\"opcional\",\"params\":{},\"requiresConfirmation\":false,\"dangerLevel\":\"low\"}]"
            "}.\n"
            "Para un buscador, usa type=form con config.fields y config.actions de tipo open_url. "
            "Ejemplo buscador: config.fields=[{\"id\":\"query\",\"label\":\"Busqueda\",\"type\":\"search\"}], "
            "config.actions=[{\"id\":\"search\",\"label\":\"Buscar\",\"type\":\"open_url\",\"urlTemplate\":\"https://www.google.com/search?q={query}\"}]. "
            "Para calculadora, usa type=form con action calculate_expression. "
            "Para monitor, usa internal_tool si hay herramienta adecuada. "
            "Para tablas, devuelve columnas y filas iniciales utiles.\n\n"
            f"Contexto compacto: {json.dumps(_tiny_context(tool_context), ensure_ascii=False)}\n"
            f"Solicitud: {user_prompt}"
        )
        response = await self._ask_codex(prompt, {})
        if not response:
            response = await self._ask_google(prompt, {}, max_output_tokens=1800)
        return _coerce_declarative_manifest(response, user_prompt, next_index)

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

    async def _ask_google(self, user_message: str, tool_context: dict[str, object], max_output_tokens: int = 420) -> str:
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
                "maxOutputTokens": max_output_tokens,
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
    allowed = {"chat", "metrics", "config", "logs", "assets", "self", "terminal", "custom", "live"}
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
    runtime = _coerce_runtime_widget(payload.get("runtime"), user_prompt, widget_type)
    if runtime:
        widget_type = "live"
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
        "size": _coerce_widget_size(payload.get("size"), widget_type),
        "runtime": runtime,
        "custom": _coerce_custom_widget(payload.get("custom"), user_prompt, widget_type),
    }


def _coerce_declarative_manifest(text: str, user_prompt: str, next_index: int) -> WidgetManifest:
    payload = _extract_json_object(text)
    fallback = _fallback_declarative_payload(user_prompt)
    if not payload:
        payload = fallback
    allowed_types = {
        "status_card",
        "metric_card",
        "metric_grid",
        "line_chart",
        "bar_chart",
        "table",
        "log_viewer",
        "markdown",
        "checklist",
        "form",
        "image_preview",
        "web_preview",
        "command_panel",
        "service_monitor",
        "calendar_panel",
        "file_panel",
        "chat_panel",
        "automation_panel",
        "iframe_sandbox",
    }
    allowed_sources = {"static", "mock", "internal_tool", "http_endpoint", "local_storage", "system_metric", "manual_input"}
    allowed_tools = {
        "get_system_status",
        "get_network_status",
        "get_cpu_ram_status",
        "get_storage_status",
        "get_recent_logs",
        "get_service_status",
        "get_calendar_preview",
        "get_assets_list",
        "sync_workspace",
        "restart_service",
    }

    widget_type = str(payload.get("type") or fallback["type"]).strip()
    if widget_type not in allowed_types:
        widget_type = fallback["type"]
    title = str(payload.get("title") or fallback["title"]).strip()[:80] or fallback["title"]
    description = str(payload.get("description") or fallback["description"]).strip()[:240]
    config = payload.get("config") if isinstance(payload.get("config"), dict) else fallback.get("config", {})
    data_source = payload.get("dataSource") if isinstance(payload.get("dataSource"), dict) else fallback.get("dataSource", {"type": "mock"})
    source_type = str(data_source.get("type") or "mock")
    if source_type not in allowed_sources:
        source_type = "mock"
    tool_name = data_source.get("toolName")
    if tool_name and tool_name not in allowed_tools:
        tool_name = None
    if source_type == "internal_tool" and not tool_name:
        source_type = "mock"
    try:
        refresh = int(payload.get("refreshInterval") or fallback.get("refreshInterval") or 0)
    except (TypeError, ValueError):
        refresh = 0
    refresh = max(0, min(600000, refresh))

    actions = []
    for item in payload.get("actions", []) if isinstance(payload.get("actions"), list) else fallback.get("actions", []):
        if not isinstance(item, dict):
            continue
        action_tool = item.get("toolName")
        if action_tool and action_tool not in allowed_tools:
            action_tool = None
        actions.append(
            {
                "id": _safe_token(str(item.get("id") or item.get("label") or "action"))[:80],
                "label": str(item.get("label") or "Ejecutar").strip()[:80],
                "toolName": action_tool,
                "params": item.get("params") if isinstance(item.get("params"), dict) else {},
                "requiresConfirmation": bool(item.get("requiresConfirmation")),
                "dangerLevel": item.get("dangerLevel") if item.get("dangerLevel") in {"low", "medium", "high", "critical"} else "low",
            }
        )

    base_x = 96 + (next_index % 4) * 34
    base_y = 96 + (next_index % 5) * 30
    size = _widget_size_for(widget_type, config)
    safe_config = _ensure_functional_config(widget_type, _sanitize_widget_config(config), user_prompt, title)
    manifest = {
        "id": f"widget_{_safe_token(title)}_{secrets.token_hex(3)}",
        "type": widget_type,
        "title": title,
        "description": description,
        "layout": {"x": base_x, "y": base_y, "w": size["w"], "h": size["h"], "zIndex": next_index + 2},
        "refreshInterval": refresh,
        "dataSource": {
            "type": source_type,
            "toolName": tool_name,
            "endpoint": data_source.get("endpoint") if source_type == "http_endpoint" else None,
            "params": data_source.get("params") if isinstance(data_source.get("params"), dict) else {},
        },
        "config": safe_config,
        "actions": actions[:12],
        "permissions": {"canRead": True, "canWrite": widget_type in {"form", "checklist"}, "canExecuteActions": True},
    }
    try:
        return validate_manifest(manifest)
    except Exception:
        return manifest_from_intent(user_prompt, next_index)


def _extract_json_object(text: str) -> dict[str, Any]:
    if not text:
        return {}
    cleaned = text.strip()
    match = re.search(r"\{.*\}", cleaned, re.S)
    if match:
        cleaned = match.group(0)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _fallback_declarative_payload(prompt: str) -> dict[str, Any]:
    text = prompt.lower()
    if re.search(r"busc|search|google|web", text):
        return {
            "type": "form",
            "title": "Buscador web",
            "description": "Buscador generado por JARVIS.",
            "dataSource": {"type": "manual_input", "params": {}},
            "config": {
                "fields": [{"id": "query", "label": "Busqueda", "type": "search", "placeholder": "Texto a buscar"}],
                "actions": [{"id": "search", "label": "Buscar", "type": "open_url", "urlTemplate": "https://www.google.com/search?q={query}"}],
                "notes": ["Introduce una consulta y pulsa Buscar."],
            },
        }
    if re.search(r"calcul|calc|operaci[oó]n", text):
        return {
            "type": "form",
            "title": "Calculadora",
            "description": "Calculadora local generada por JARVIS.",
            "dataSource": {"type": "manual_input", "params": {}},
            "config": {
                "fields": [{"id": "expression", "label": "Operacion", "type": "text", "placeholder": "Ejemplo: 6*6"}],
                "actions": [{"id": "calculate", "label": "Calcular", "type": "calculate_expression", "field": "expression"}],
                "notes": ["Solo admite numeros y operadores matematicos basicos."],
            },
        }
    if re.search(r"formulario|form", text):
        return {
            "type": "form",
            "title": "Formulario",
            "description": "Formulario personalizado generado por JARVIS.",
            "dataSource": {"type": "manual_input", "params": {}},
            "config": {
                "fields": [{"id": "value", "label": "Valor", "type": "text", "placeholder": "Introduce un dato"}],
                "actions": [{"id": "save", "label": "Guardar", "type": "show_value", "field": "value"}],
            },
        }
    return manifest_from_intent(prompt, 1).model_dump()


def _widget_size_for(widget_type: str, config: dict[str, Any]) -> dict[str, int]:
    defaults = {
        "metric_grid": {"w": 480, "h": 300},
        "table": {"w": 560, "h": 340},
        "log_viewer": {"w": 540, "h": 360},
        "form": {"w": 460, "h": 340},
        "web_preview": {"w": 620, "h": 430},
        "service_monitor": {"w": 500, "h": 340},
        "chat_panel": {"w": 520, "h": 380},
    }
    size = defaults.get(widget_type, {"w": 430, "h": 290}).copy()
    raw_size = config.get("size") if isinstance(config, dict) else None
    if isinstance(raw_size, dict):
        for key in ("w", "h"):
            try:
                size[key] = int(raw_size.get(key, size[key]))
            except (TypeError, ValueError):
                pass
    size["w"] = max(260, min(1200, size["w"]))
    size["h"] = max(180, min(900, size["h"]))
    return size


def _sanitize_widget_config(config: dict[str, Any]) -> dict[str, Any]:
    safe = dict(config)
    for forbidden in ("runtime", "html", "css", "js", "script"):
        safe.pop(forbidden, None)
    if isinstance(safe.get("fields"), list):
        safe["fields"] = [_coerce_safe_form_field(item) for item in safe["fields"] if isinstance(item, dict)][:12]
    if isinstance(safe.get("actions"), list):
        safe["actions"] = [_coerce_safe_form_action(item) for item in safe["actions"] if isinstance(item, dict)][:12]
    return safe


def _ensure_functional_config(widget_type: str, config: dict[str, Any], prompt: str, title: str) -> dict[str, Any]:
    if widget_type != "form":
        return config
    text = f"{prompt} {title}".lower()
    fields = config.get("fields") if isinstance(config.get("fields"), list) else []
    actions = config.get("actions") if isinstance(config.get("actions"), list) else []
    if not fields:
        if re.search(r"busc|search|google|web", text):
            fields = [{"id": "query", "label": "Busqueda", "type": "search", "placeholder": "Texto a buscar", "options": []}]
        elif re.search(r"calcul|calc|operaci[oó]n", text):
            fields = [{"id": "expression", "label": "Operacion", "type": "text", "placeholder": "Ejemplo: 6*6", "options": []}]
        else:
            fields = [{"id": "value", "label": "Valor", "type": "text", "placeholder": "Introduce un dato", "options": []}]
    primary_field = fields[0].get("id") or "value"
    if not actions:
        if re.search(r"busc|search|google|web", text):
            actions = [{"id": "search", "label": "Buscar", "type": "open_url", "urlTemplate": "https://www.google.com/search?q={%s}" % primary_field, "field": primary_field}]
        elif re.search(r"calcul|calc|operaci[oó]n", text):
            actions = [{"id": "calculate", "label": "Calcular", "type": "calculate_expression", "field": primary_field}]
        else:
            actions = [{"id": "show", "label": "Mostrar", "type": "show_value", "field": primary_field}]
    config["fields"] = fields
    config["actions"] = actions
    return config


def _coerce_safe_form_field(item: dict[str, Any]) -> dict[str, Any]:
    field_type = str(item.get("type") or "text").lower()
    if field_type not in {"text", "search", "number", "textarea", "select", "url"}:
        field_type = "text"
    return {
        "id": _safe_token(str(item.get("id") or item.get("label") or "value"))[:40],
        "label": str(item.get("label") or "Valor").strip()[:60],
        "type": field_type,
        "placeholder": str(item.get("placeholder") or "").strip()[:100],
        "options": [str(option).strip()[:80] for option in item.get("options", [])[:20]] if isinstance(item.get("options"), list) else [],
    }


def _coerce_safe_form_action(item: dict[str, Any]) -> dict[str, Any]:
    action_type = str(item.get("type") or "show_value").lower()
    if action_type not in {"open_url", "ask_jarvis", "tool_call", "show_value", "calculate_expression"}:
        action_type = "show_value"
    return {
        "id": _safe_token(str(item.get("id") or item.get("label") or action_type))[:40],
        "label": str(item.get("label") or "Ejecutar").strip()[:60],
        "type": action_type,
        "urlTemplate": str(item.get("urlTemplate") or "").strip()[:500],
        "promptTemplate": str(item.get("promptTemplate") or "").strip()[:700],
        "field": _safe_token(str(item.get("field") or ""))[:40],
        "tool": str(item.get("tool") or "").strip()[:80],
        "arguments": item.get("arguments") if isinstance(item.get("arguments"), dict) else {},
    }


def _coerce_widget_size(value: Any, widget_type: str) -> dict[str, int]:
    defaults = {
        "chat": {"w": 860, "h": 540},
        "metrics": {"w": 430, "h": 360},
        "config": {"w": 500, "h": 520},
        "logs": {"w": 470, "h": 380},
        "assets": {"w": 470, "h": 430},
        "self": {"w": 470, "h": 360},
        "terminal": {"w": 560, "h": 360},
        "live": {"w": 520, "h": 360},
        "custom": {"w": 460, "h": 340},
    }
    base = defaults.get(widget_type, defaults["custom"]).copy()
    if not isinstance(value, dict):
        return base
    for key in ("w", "h"):
        try:
            base[key] = max(220 if key == "h" else 300, min(820 if key == "h" else 980, int(value.get(key, base[key]))))
        except (TypeError, ValueError):
            pass
    return base


def _coerce_custom_widget(value: Any, user_prompt: str, widget_type: str) -> dict[str, Any]:
    if widget_type != "custom":
        return {}
    if isinstance(value, dict):
        custom = value
    else:
        custom = _fallback_custom_widget(user_prompt)

    fields = [_coerce_custom_field(item) for item in custom.get("fields", []) if isinstance(item, dict)]
    actions = [_coerce_custom_action(item) for item in custom.get("actions", []) if isinstance(item, dict)]
    notes = [str(item).strip()[:120] for item in custom.get("notes", [])[:5] if str(item).strip()]
    if not fields and not actions:
        custom = _fallback_custom_widget(user_prompt)
        fields = [_coerce_custom_field(item) for item in custom["fields"]]
        actions = [_coerce_custom_action(item) for item in custom["actions"]]
        notes = custom.get("notes", [])
    return {
        "kind": _safe_token(str(custom.get("kind") or "form"))[:24] or "form",
        "fields": [item for item in fields if item],
        "actions": [item for item in actions if item],
        "notes": notes,
    }


def _coerce_runtime_widget(value: Any, user_prompt: str, widget_type: str) -> dict[str, str]:
    if isinstance(value, dict):
        html = str(value.get("html") or "").strip()
        css = str(value.get("css") or "").strip()
        js = str(value.get("js") or "").strip()
        if html or css or js:
            return {
                "html": _strip_disallowed_runtime_html(html)[:12000],
                "css": css[:12000],
                "js": _strip_disallowed_runtime_js(js)[:18000],
            }
    if widget_type == "live" or _should_force_live_widget(user_prompt):
        return _fallback_live_widget(user_prompt)
    return {}


def _strip_disallowed_runtime_html(value: str) -> str:
    value = re.sub(r"<\s*script\b[^>]*>.*?<\s*/\s*script\s*>", "", value, flags=re.I | re.S)
    value = re.sub(r"\son[a-z]+\s*=\s*(['\"]).*?\1", "", value, flags=re.I | re.S)
    return value


def _strip_disallowed_runtime_js(value: str) -> str:
    blocked = [
        r"\bfetch\s*\(",
        r"\bXMLHttpRequest\b",
        r"\blocalStorage\b",
        r"\bsessionStorage\b",
        r"\bdocument\.cookie\b",
        r"\bparent\.",
        r"\btop\.",
        r"\bopener\.",
    ]
    for pattern in blocked:
        value = re.sub(pattern, "/* blocked */", value, flags=re.I)
    return value


def _should_force_live_widget(prompt: str) -> bool:
    text = prompt.lower()
    return bool(
        re.search(
            r"widget|herramienta|buscador|buscar|search|calculadora|formulario|panel|monitor|botonera|temporizador|timer|nota|conversor|dashboard",
            text,
        )
    )


def _fallback_live_widget(prompt: str) -> dict[str, str]:
    text = prompt.lower()
    if re.search(r"busc|search|google|web", text):
        return {
            "html": """
<div class="live-card">
  <label>Busqueda web</label>
  <div class="row">
    <input id="query" type="search" placeholder="Escribe una consulta" autofocus>
    <button id="search">Buscar</button>
  </div>
  <p id="status">Widget creado por JARVIS en tiempo real.</p>
</div>
""".strip(),
            "css": """
.live-card { display: grid; gap: 14px; height: 100%; align-content: start; }
label { color: #00f0ff; font-size: 12px; font-weight: 800; text-transform: uppercase; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
input, button { min-height: 42px; border-radius: 10px; border: 1px solid rgba(0,240,255,.45); background: rgba(0,8,14,.9); color: #e8fcff; padding: 0 12px; font: inherit; }
button { cursor: pointer; color: #001014; background: linear-gradient(90deg, #00f0ff, #00ebd4); font-weight: 900; }
p { margin: 0; color: #7ca7b7; line-height: 1.45; }
""".strip(),
            "js": """
const input = document.getElementById('query');
const status = document.getElementById('status');
function runSearch() {
  const query = input.value.trim();
  if (!query) {
    status.textContent = 'Introduce una busqueda.';
    return;
  }
  JARVIS.openUrl('https://www.google.com/search?q=' + encodeURIComponent(query));
  status.textContent = 'Busqueda abierta: ' + query;
}
document.getElementById('search').addEventListener('click', runSearch);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runSearch();
});
""".strip(),
        }
    return {
        "html": """
<div class="live-card">
  <label>Orden a JARVIS</label>
  <textarea id="request" placeholder="Escribe una orden para este widget"></textarea>
  <button id="send">Ejecutar</button>
  <pre id="output">Widget vivo creado por JARVIS.</pre>
</div>
""".strip(),
        "css": """
.live-card { display: grid; gap: 12px; height: 100%; }
label { color: #00f0ff; font-size: 12px; font-weight: 800; text-transform: uppercase; }
textarea, button, pre { border-radius: 10px; border: 1px solid rgba(0,240,255,.45); background: rgba(0,8,14,.88); color: #e8fcff; font: inherit; }
textarea { min-height: 92px; resize: vertical; padding: 12px; }
button { min-height: 42px; cursor: pointer; color: #001014; background: linear-gradient(90deg, #00f0ff, #00ebd4); font-weight: 900; }
pre { min-height: 100px; margin: 0; padding: 12px; white-space: pre-wrap; overflow: auto; }
""".strip(),
        "js": """
const request = document.getElementById('request');
const output = document.getElementById('output');
document.getElementById('send').addEventListener('click', async () => {
  const message = request.value.trim();
  if (!message) return;
  output.textContent = 'Consultando a JARVIS...';
  const result = await JARVIS.chat(message);
  output.textContent = result.text || JSON.stringify(result, null, 2);
});
""".strip(),
    }


def _coerce_custom_field(item: dict[str, Any]) -> dict[str, Any]:
    field_type = str(item.get("type") or "text").lower()
    if field_type not in {"text", "search", "number", "textarea", "select"}:
        field_type = "text"
    field_id = _safe_token(str(item.get("id") or item.get("label") or "value"))
    options = [str(option).strip()[:40] for option in item.get("options", [])[:12] if str(option).strip()]
    return {
        "id": field_id[:32] or "value",
        "label": str(item.get("label") or field_id or "Valor").strip()[:24],
        "type": field_type,
        "placeholder": str(item.get("placeholder") or "").strip()[:60],
        "options": options,
    }


def _coerce_custom_action(item: dict[str, Any]) -> dict[str, Any]:
    action_type = str(item.get("type") or "show_value").lower()
    if action_type not in {"open_url", "ask_jarvis", "tool_call", "show_value"}:
        action_type = "show_value"
    action_id = _safe_token(str(item.get("id") or item.get("label") or action_type))
    allowed_tools = {
        "vitals.report",
        "threats.scan",
        "docker.summary",
        "docker.restart",
        "jarvis.self_status",
        "jarvis.self_restart",
        "system.host_shell",
        "memory.incidents",
        "asset.command",
    }
    tool = str(item.get("tool") or "")
    if action_type == "tool_call" and tool not in allowed_tools:
        tool = "jarvis.self_status"
    return {
        "id": action_id[:32] or action_type,
        "label": str(item.get("label") or action_id or "Ejecutar").strip()[:24],
        "type": action_type,
        "urlTemplate": str(item.get("urlTemplate") or "").strip()[:500],
        "promptTemplate": str(item.get("promptTemplate") or "").strip()[:700],
        "tool": tool,
        "arguments": item.get("arguments") if isinstance(item.get("arguments"), dict) else {},
    }


def _fallback_custom_widget(prompt: str) -> dict[str, Any]:
    text = prompt.lower()
    if re.search(r"busc|search|google|web", text):
        return {
            "kind": "search",
            "fields": [
                {"id": "query", "label": "Busqueda", "type": "search", "placeholder": "Texto a buscar"},
            ],
            "actions": [
                {
                    "id": "search",
                    "label": "Buscar",
                    "type": "open_url",
                    "urlTemplate": "https://www.google.com/search?q={query}",
                }
            ],
            "notes": ["Buscador generado en el dashboard."],
        }
    return {
        "kind": "assistant",
        "fields": [
            {"id": "request", "label": "Orden", "type": "textarea", "placeholder": "Indica que debe hacer JARVIS"},
        ],
        "actions": [
            {
                "id": "ask",
                "label": "Enviar a JARVIS",
                "type": "ask_jarvis",
                "promptTemplate": "{request}",
            }
        ],
        "notes": ["Widget personalizado generado por JARVIS."],
    }


def _safe_token(value: str) -> str:
    token = re.sub(r"[^a-zA-Z0-9_]+", "_", value.strip().lower()).strip("_")
    return token or "value"


def _infer_widget_type(prompt: str) -> str:
    text = prompt.lower()
    if _should_force_live_widget(prompt):
        return "live"
    if re.search(r"buscador|buscar|search|calculadora|formulario|widget personalizado|personalizado|crear widget|genera un widget", text):
        return "custom"
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
        "live": "Live Widget",
        "custom": "Dynamic Widget",
    }
    if widget_type != "custom":
        return defaults[widget_type]
    return re.sub(r"[^\w\sáéíóúñ]", "", prompt, flags=re.I).strip()[:34] or "Dynamic Widget"


def _load_personality_prompt() -> str:
    prompt_parts: list[str] = []
    directories = [
        Path("/data/personality"),
        Path("/app/personality"),
        Path(__file__).resolve().parents[1] / "personality",
    ]
    for directory in directories:
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*.md")):
            try:
                text = path.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if text:
                prompt_parts.append(f"# {path.stem}\n{text}")
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
            prompt_parts.insert(0, text)
            break
    if prompt_parts:
        return "\n\n".join(prompt_parts)
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
