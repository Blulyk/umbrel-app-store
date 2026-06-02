import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from alfred.asset_registry import AssetRegistry
from alfred.config import get_settings
from alfred.docker_control import docker_summary
from alfred.hermes import HermesClient
from alfred.memory import MemoryStore
from alfred.schemas import (
    AssetCommandRequest,
    CanvasImportRequest,
    ChatRequest,
    ToolCallRequest,
    WidgetActionRequest,
    WidgetCommandRequest,
    WidgetManifestRequest,
    WidgetPatchRequest,
)
from alfred.threats import scan_auth_log
from alfred.tool_router import ToolRouter
from alfred.vitals import vitals_payload
from alfred.widget_engine import WidgetLayoutDocument, load_layout, manifest_from_intent, save_layout, validate_manifest

settings = get_settings()
memory = MemoryStore(settings.db_path)
assets = AssetRegistry(settings.fernet_key)
hermes = HermesClient(settings.hermes_base_url, settings.hermes_model)
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


@app.get("/audit")
async def audit_log(limit: int = 100) -> list[dict[str, Any]]:
    return await memory.recent_audit(max(1, min(limit, 250)))


@app.get("/widgets")
async def list_canvas_widgets() -> dict[str, Any]:
    return (await load_layout(memory)).model_dump()


@app.post("/widgets")
async def create_canvas_widget(request: WidgetManifestRequest) -> dict[str, Any]:
    layout = await load_layout(memory)
    try:
        manifest = validate_manifest(request.manifest)
    except Exception as exc:
        await audit("widget.validation_error", "widget-engine", f"Invalid widget manifest: {exc}", {"manifest": request.manifest}, "error")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    layout.widgets = [widget for widget in layout.widgets if widget.id != manifest.id]
    layout.widgets.append(manifest)
    await save_layout(memory, layout)
    await audit("widget.created", "widget-engine", f"Created widget {manifest.title}", {"id": manifest.id, "type": manifest.type})
    return {"ok": True, "widget": manifest.model_dump(), "layout": layout.model_dump()}


@app.get("/widgets/{widget_id}")
async def get_canvas_widget(widget_id: str) -> dict[str, Any]:
    layout = await load_layout(memory)
    widget = next((item for item in layout.widgets if item.id == widget_id), None)
    if widget is None:
        raise HTTPException(status_code=404, detail="Widget not found.")
    return {"ok": True, "widget": widget.model_dump()}


@app.patch("/widgets/{widget_id}")
async def update_canvas_widget(widget_id: str, request: WidgetPatchRequest) -> dict[str, Any]:
    layout = await load_layout(memory)
    widgets = []
    updated = None
    for widget in layout.widgets:
        if widget.id != widget_id:
            widgets.append(widget)
            continue
        payload = deep_merge(widget.model_dump(), request.patch)
        updated = validate_manifest(payload)
        widgets.append(updated)
    if updated is None:
        raise HTTPException(status_code=404, detail="Widget not found.")
    layout.widgets = widgets
    await save_layout(memory, layout)
    await audit("widget.updated", "widget-engine", f"Updated widget {updated.title}", {"id": updated.id, "patch": request.patch})
    return {"ok": True, "widget": updated.model_dump(), "layout": layout.model_dump()}


@app.delete("/widgets/{widget_id}")
async def delete_canvas_widget(widget_id: str) -> dict[str, Any]:
    layout = await load_layout(memory)
    before = len(layout.widgets)
    layout.widgets = [widget for widget in layout.widgets if widget.id != widget_id]
    if len(layout.widgets) == before:
        raise HTTPException(status_code=404, detail="Widget not found.")
    await save_layout(memory, layout)
    await audit("widget.deleted", "widget-engine", f"Deleted widget {widget_id}", {"id": widget_id})
    return {"ok": True, "layout": layout.model_dump()}


@app.post("/widgets/{widget_id}/duplicate")
async def duplicate_canvas_widget(widget_id: str) -> dict[str, Any]:
    layout = await load_layout(memory)
    widget = next((item for item in layout.widgets if item.id == widget_id), None)
    if widget is None:
        raise HTTPException(status_code=404, detail="Widget not found.")
    payload = widget.model_dump()
    payload["id"] = f"{widget.id}_copy_{len(layout.widgets) + 1}"
    payload["title"] = f"{widget.title} copy"[:80]
    payload["layout"]["x"] += 28
    payload["layout"]["y"] += 28
    clone = validate_manifest(payload)
    layout.widgets.append(clone)
    await save_layout(memory, layout)
    await audit("widget.duplicated", "widget-engine", f"Duplicated widget {widget.title}", {"source": widget_id, "id": clone.id})
    return {"ok": True, "widget": clone.model_dump(), "layout": layout.model_dump()}


@app.delete("/widgets")
async def clear_canvas_widgets(confirm: bool = False) -> dict[str, Any]:
    if not confirm:
        raise HTTPException(status_code=400, detail="Clearing the canvas requires confirm=true.")
    layout = await load_layout(memory)
    count = len(layout.widgets)
    layout.widgets = []
    await save_layout(memory, layout)
    await audit("canvas.cleared", "widget-engine", f"Cleared {count} widgets", {"count": count}, "warning")
    return {"ok": True, "layout": layout.model_dump()}


@app.post("/widgets/import")
async def import_canvas_layout(request: CanvasImportRequest) -> dict[str, Any]:
    try:
        layout = WidgetLayoutDocument.model_validate(request.layout)
    except Exception as exc:
        await audit("canvas.import_error", "widget-engine", f"Invalid canvas import: {exc}", {}, "error")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await save_layout(memory, layout)
    await audit("canvas.imported", "widget-engine", "Imported canvas layout", {"widgets": len(layout.widgets)})
    return {"ok": True, "layout": layout.model_dump()}


@app.post("/widgets/command")
async def jarvis_widget_command(request: WidgetCommandRequest) -> dict[str, Any]:
    layout = await load_layout(memory)
    command = request.command.strip()
    await audit("command.text", "command-bar", command, {"selected": request.selected_widget_id})
    result = await route_widget_command(command, layout, request.selected_widget_id)
    await save_layout(memory, layout)
    return {"ok": True, **result, "layout": layout.model_dump()}


@app.post("/widgets/{widget_id}/actions")
async def run_widget_action(widget_id: str, request: WidgetActionRequest) -> dict[str, Any]:
    layout = await load_layout(memory)
    widget = next((item for item in layout.widgets if item.id == widget_id), None)
    if widget is None:
        raise HTTPException(status_code=404, detail="Widget not found.")
    action = next((item for item in widget.actions if item.id == request.action_id), None)
    if action is None:
        raise HTTPException(status_code=404, detail="Action not found.")
    if not widget.permissions.canExecuteActions or widget.permissions.readOnly:
        raise HTTPException(status_code=403, detail="Widget action execution is disabled.")
    if action.requiresConfirmation and not request.confirm:
        raise HTTPException(status_code=409, detail="Action requires confirmation.")
    result = await tools.execute(action.toolName or "", action.params)
    await audit(
        "widget.action",
        widget.id,
        f"Executed action {action.label}",
        {"widget": widget.id, "action": action.model_dump(), "result": result},
        "warning" if action.dangerLevel in {"high", "critical"} else "info",
    )
    return {"ok": True, "result": result}


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
        except Exception as exc:
            fallback = alfred_fallback(request.message, context, exc)
            yield fallback.encode()

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8")


async def maybe_execute_json_tool(message: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(message)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or "tool" not in payload:
        return None
    return await tools.execute(str(payload["tool"]), payload.get("arguments") or {})


async def audit(
    event_type: str,
    source: str,
    message: str,
    metadata: dict[str, Any] | None = None,
    severity: str = "info",
) -> None:
    import uuid

    await memory.record_audit(f"audit_{uuid.uuid4().hex}", event_type, source, message, metadata or {}, severity)


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


async def route_widget_command(command: str, layout: WidgetLayoutDocument, selected_id: str | None) -> dict[str, Any]:
    normalized = " ".join(command.lower().split())
    selected = next((item for item in layout.widgets if item.id == selected_id), None)
    target = selected or (layout.widgets[-1] if layout.widgets else None)

    if normalized in {"limpia el canvas", "limpiar canvas", "borra todo", "clear canvas"}:
        return {"requiresConfirmation": True, "action": "clear_canvas", "message": "Clearing the canvas requires confirmation."}
    if normalized in {"confirmar limpiar canvas", "confirma limpiar canvas", "confirm clear canvas"}:
        count = len(layout.widgets)
        layout.widgets = []
        await audit("canvas.cleared", "command-router", f"Cleared {count} widgets by confirmation", {"count": count}, "warning")
        return {"message": "Canvas cleared."}
    if "borra" in normalized or "elimina" in normalized:
        if target is None:
            return {"message": "No widget selected to delete."}
        layout.widgets = [item for item in layout.widgets if item.id != target.id]
        await audit("widget.deleted", "command-router", f"Deleted widget {target.title}", {"id": target.id})
        return {"message": f"Deleted {target.title}."}
    if ("mueve" in normalized or "pon" in normalized) and target:
        patch = target.model_dump()
        if "arriba" in normalized:
            patch["layout"]["y"] = 40
        if "abajo" in normalized:
            patch["layout"]["y"] = 620
        if "derecha" in normalized:
            patch["layout"]["x"] = 760
        if "izquierda" in normalized:
            patch["layout"]["x"] = 60
        updated = validate_manifest(patch)
        layout.widgets = [updated if item.id == target.id else item for item in layout.widgets]
        await audit("widget.moved", "command-router", f"Moved widget {updated.title}", {"id": updated.id, "layout": updated.layout.model_dump()})
        return {"widget": updated.model_dump(), "message": f"Moved {updated.title}."}
    if ("grande" in normalized or "peque" in normalized or "resize" in normalized) and target:
        patch = target.model_dump()
        factor = 1.18 if "grande" in normalized else 0.84
        patch["layout"]["w"] = max(260, min(1200, int(target.layout.w * factor)))
        patch["layout"]["h"] = max(180, min(900, int(target.layout.h * factor)))
        updated = validate_manifest(patch)
        layout.widgets = [updated if item.id == target.id else item for item in layout.widgets]
        await audit("widget.resized", "command-router", f"Resized widget {updated.title}", {"id": updated.id, "layout": updated.layout.model_dump()})
        return {"widget": updated.model_dump(), "message": f"Resized {updated.title}."}
    if "cada" in normalized and "seg" in normalized and target:
        import re

        match = re.search(r"cada\s+(\d+)\s*seg", normalized)
        if match:
            patch = target.model_dump()
            patch["refreshInterval"] = int(match.group(1)) * 1000
            updated = validate_manifest(patch)
            layout.widgets = [updated if item.id == target.id else item for item in layout.widgets]
            await audit("widget.updated", "command-router", f"Updated refresh interval for {updated.title}", {"id": updated.id, "refreshInterval": updated.refreshInterval})
            return {"widget": updated.model_dump(), "message": f"{updated.title} refreshes every {match.group(1)} seconds."}

    manifest = manifest_from_intent(command, len(layout.widgets) + 1)
    layout.widgets.append(manifest)
    await audit("widget.created", "command-router", f"Created widget {manifest.title}", {"id": manifest.id, "type": manifest.type})
    return {"widget": manifest.model_dump(), "message": f"Created {manifest.title}."}


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


def alfred_fallback(message: str, context: dict[str, Any], exc: Exception) -> str:
    return (
        "Hermes uplink unavailable. Local analysis follows.\n"
        f"Request: {message}\n"
        f"Telemetry: {json.dumps(context, ensure_ascii=False, indent=2)}\n"
        f"Fault: {exc}\n"
        "Recommendation: restore the Hermes endpoint before expecting conversational finesse."
    )


def run() -> None:
    import uvicorn

    uvicorn.run("alfred.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    run()
