import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from alfred.asset_registry import AssetRegistry
from alfred.brain import JarvisBrain
from alfred.config import get_settings
from alfred.docker_control import docker_summary
from alfred.memory import MemoryStore
from alfred.schemas import AssetCommandRequest, ChatRequest, OpenAISettingsRequest, ToolCallRequest
from alfred.threats import scan_auth_log
from alfred.tool_router import ToolRouter
from alfred.vitals import vitals_payload

settings = get_settings()
memory = MemoryStore(settings.db_path)
assets = AssetRegistry(settings.fernet_key)
brain = JarvisBrain(settings, memory)
tools = ToolRouter(settings, memory, assets)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await memory.init()
    yield


app = FastAPI(title="JARVIS Orchestrator", version="1.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="alfred/static"), name="static")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "operational", "assessment": "JARVIS core online."}


@app.get("/status")
async def status() -> dict[str, Any]:
    context = await gather_context()
    return {
        "identity": {
            "name": "JARVIS",
            "full_name": "Just A Rather Very Intelligent System",
            "mode": "OpenAI cognitive core with local reflex orchestration",
        },
        "brain": await brain.status(),
        "context": context,
        "capabilities": tools.catalog(),
    }


@app.post("/settings/openai")
async def configure_openai(request: OpenAISettingsRequest) -> dict[str, Any]:
    await brain.save_openai_key(request.api_key, request.model)
    return {"ok": True, "brain": await brain.status()}


@app.get("/")
async def dashboard() -> FileResponse:
    return FileResponse("alfred/static/index.html", media_type="text/html")


@app.get("/asset-bridge/config")
async def asset_bridge_config() -> dict[str, str]:
    return {
        "asset_id": "main-pc",
        "websocket_path": "/ws/asset",
        "bridge_key": settings.fernet_key,
        "note": "Umbrel proxy authentication protects this value. Treat it as a remote-control credential.",
    }


@app.get("/vitals")
async def vitals() -> dict[str, object]:
    payload = vitals_payload(settings)
    if payload["status"] != "Nominal":
        await memory.record_incident(
            severity="warning",
            category="vitals",
            summary=str(payload["status"]),
            payload=payload,
        )
    return payload


@app.get("/threats")
async def threats() -> dict[str, object]:
    payload = scan_auth_log(settings.auth_log_path)
    if payload["status"] == "Anomalous":
        await memory.record_incident(
            severity="warning",
            category="perimeter",
            summary="Intrusion anomalies detected.",
            payload=payload,
        )
    return payload


@app.get("/docker")
async def docker() -> dict[str, Any]:
    return await asyncio.to_thread(docker_summary, settings)


@app.get("/memory/incidents")
async def incidents() -> list[dict[str, Any]]:
    return await memory.recent_incidents()


@app.get("/assets")
async def list_assets() -> list[dict[str, str]]:
    return await assets.list_assets()


@app.get("/tools")
async def list_tools() -> list[dict[str, Any]]:
    return tools.catalog()


@app.post("/tools")
async def call_tool(request: ToolCallRequest) -> dict[str, Any]:
    return await tools.execute(request.tool, request.arguments)


@app.post("/assets/{asset_id}/command")
async def command_asset(asset_id: str, request: AssetCommandRequest) -> dict[str, Any]:
    result = await assets.send_command(asset_id, request.action, request.payload)
    await memory.record_asset_event(asset_id, request.action, result)
    return result


@app.websocket("/ws/asset")
async def asset_socket(websocket: WebSocket) -> None:
    asset_id = websocket.query_params.get("asset_id", "unknown-asset")
    await websocket.accept()
    await assets.connect(asset_id, websocket)
    await memory.record_asset_event(asset_id, "connected", {"remote": str(websocket.client)})
    try:
        while True:
            encrypted = await websocket.receive_text()
            message = await assets.handle_asset_message(encrypted)
            if message and message.get("event"):
                await memory.record_asset_event(asset_id, str(message["event"]), message)
    except WebSocketDisconnect:
        await assets.disconnect(asset_id)
        await memory.record_asset_event(asset_id, "disconnected", {})


@app.post("/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    async def stream() -> AsyncIterator[bytes]:
        local_reply = await maybe_answer_locally(request.message)
        if local_reply:
            yield local_reply.encode()
            return
        tool_result = await maybe_execute_json_tool(request.message)
        if tool_result is not None:
            yield json.dumps(tool_result, ensure_ascii=False, indent=2).encode()
            return
        context = await gather_context()
        try:
            async for chunk in brain.stream_chat(request.message, context):
                yield chunk.encode()
        except Exception:
            yield "La mente OpenAI de JARVIS no devolvio una respuesta final.".encode()

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8")


async def maybe_answer_locally(message: str) -> str | None:
    normalized = " ".join(message.lower().split())
    if normalized in {"hola", "buenas", "jarvis", "hey jarvis"}:
        context = await gather_context()
        return format_briefing(context, await brain.status())
    if normalized in {"estado", "status", "sistema", "diagnostico", "diagnóstico"}:
        context = await gather_context()
        return format_briefing(context, await brain.status())
    if normalized in {"herramientas", "capacidades", "tools", "ayuda", "que puedes hacer?", "qué puedes hacer?", "que puedes hacer", "qué puedes hacer"}:
        names = ", ".join(item["name"] for item in tools.catalog())
        return f"Puedo vigilar Umbrel, leer telemetria, revisar Docker, consultar memoria, controlar assets remotos permitidos, hablar por voz en el navegador y delegar razonamiento profundo a OpenAI cuando configures la API key. Capacidades locales: {names}."
    if normalized in {"contenedores", "docker", "containers"}:
        data = await asyncio.to_thread(docker_summary, settings)
        if not data.get("available"):
            return f"Docker no esta disponible: {data.get('error', 'sin detalle')}."
        running = sum(1 for item in data.get("containers", []) if item.get("status") == "running")
        total = len(data.get("containers", []))
        return f"Docker operativo: {running}/{total} contenedores en ejecucion."
    return None


def format_briefing(context: dict[str, Any], brain_state: dict[str, Any]) -> str:
    vitals_data = context["vitals"]
    docker_data = context["docker"]
    assets_data = context["assets"]
    docker_text = "Docker no disponible"
    if docker_data.get("available"):
        running = sum(1 for item in docker_data.get("containers", []) if item.get("status") == "running")
        docker_text = f"{running}/{len(docker_data.get('containers', []))} contenedores activos"
    return "\n".join(
        [
            f"JARVIS online. Mente: {brain_state['state']} ({brain_state['provider']}).",
            f"Sistema: {vitals_data['status']} | CPU {vitals_data['cpu_percent']:.0f}% | RAM {vitals_data['ram_percent']:.0f}% | Disco {vitals_data['disk_percent']:.0f}%.",
            f"Infraestructura: {docker_text}. Assets conectados: {len(assets_data)}.",
        ]
    )


async def maybe_execute_json_tool(message: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(message)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or "tool" not in payload:
        return None
    return await tools.execute(str(payload["tool"]), payload.get("arguments") or {})


async def gather_context() -> dict[str, Any]:
    vitals_task = asyncio.to_thread(vitals_payload, settings)
    threats_task = asyncio.to_thread(scan_auth_log, settings.auth_log_path)
    docker_task = asyncio.to_thread(docker_summary, settings)
    incidents_task = memory.recent_incidents(5)
    asset_task = assets.list_assets()
    vitals_result, threat_result, docker_result, incident_result, asset_result = await asyncio.gather(
        vitals_task, threats_task, docker_task, incidents_task, asset_task
    )
    return {
        "vitals": vitals_result,
        "threats": threat_result,
        "docker": docker_result,
        "recent_incidents": incident_result,
        "assets": asset_result,
    }


def run() -> None:
    import uvicorn

    uvicorn.run("alfred.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    run()

