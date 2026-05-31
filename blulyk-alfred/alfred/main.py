import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from alfred.asset_registry import AssetRegistry
from alfred.config import get_settings
from alfred.docker_control import docker_summary
from alfred.hermes import HermesClient
from alfred.memory import MemoryStore
from alfred.schemas import AssetCommandRequest, ChatRequest, ToolCallRequest
from alfred.threats import scan_auth_log
from alfred.tool_router import ToolRouter
from alfred.vitals import vitals_payload

settings = get_settings()
memory = MemoryStore(settings.db_path)
assets = AssetRegistry(settings.fernet_key)
hermes = HermesClient(
    settings.hermes_base_url,
    settings.hermes_model,
    settings.hermes_api_key,
    settings.hermes_state_db_path,
)
tools = ToolRouter(settings, memory, assets)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await memory.init()
    yield


app = FastAPI(title="ALFRED Orchestrator", version="0.1.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="alfred/static"), name="static")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "operational", "assessment": "Nominal. Do try to keep it that way."}


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
        tool_result = await maybe_execute_json_tool(request.message)
        if tool_result is not None:
            yield json.dumps(tool_result, ensure_ascii=False, indent=2).encode()
            return
        context = await gather_context()
        try:
            async for chunk in hermes.stream_chat(request.message, context):
                yield chunk.encode()
        except Exception:
            yield "Hermes no devolvio una respuesta final limpia.".encode()

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8")


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
