from __future__ import annotations

import re
import time
import uuid
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, ValidationError, field_validator

from alfred.memory import MemoryStore


WIDGET_LAYOUT_KEY = "jarvis_widget_layout_v1"
SCHEMA_VERSION = 1

WidgetType = Literal[
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
]

DataSourceType = Literal[
    "static",
    "mock",
    "internal_tool",
    "http_endpoint",
    "websocket",
    "local_storage",
    "system_metric",
    "manual_input",
]


class WidgetLayout(BaseModel):
    x: int = Field(80, ge=-10000, le=10000)
    y: int = Field(80, ge=-10000, le=10000)
    w: int = Field(420, ge=260, le=1200)
    h: int = Field(280, ge=180, le=900)
    zIndex: int = Field(1, ge=1, le=9999)
    locked: bool = False
    pinned: bool = False
    expanded: bool = False


class WidgetDataSource(BaseModel):
    type: DataSourceType = "mock"
    toolName: str | None = Field(None, max_length=80)
    endpoint: str | None = Field(None, max_length=500)
    params: dict[str, Any] = Field(default_factory=dict)
    refreshInterval: int | None = Field(None, ge=0, le=600000)
    errorHandling: Literal["none", "retry", "stale"] = "stale"
    lastUpdated: str | None = None

    @field_validator("endpoint")
    @classmethod
    def validate_endpoint(cls, value: str | None) -> str | None:
        if not value:
            return value
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https", "ws", "wss"}:
            raise ValueError("Only http/https/ws/wss endpoints are allowed.")
        return value


class WidgetAction(BaseModel):
    id: str = Field(default_factory=lambda: f"action_{uuid.uuid4().hex[:8]}", max_length=80)
    label: str = Field(max_length=80)
    toolName: str | None = Field(None, max_length=80)
    params: dict[str, Any] = Field(default_factory=dict)
    requiresConfirmation: bool = False
    dangerLevel: Literal["low", "medium", "high", "critical"] = "low"


class WidgetPermissions(BaseModel):
    canRead: bool = True
    canWrite: bool = False
    canExecuteActions: bool = True
    readOnly: bool = False


class WidgetManifest(BaseModel):
    id: str = Field(default_factory=lambda: f"widget_{uuid.uuid4().hex[:10]}", max_length=90)
    type: WidgetType
    title: str = Field(max_length=80)
    description: str = Field("", max_length=240)
    status: Literal["active", "paused", "loading", "stale", "error", "offline", "success"] = "active"
    layout: WidgetLayout = Field(default_factory=WidgetLayout)
    refreshInterval: int = Field(0, ge=0, le=600000)
    dataSource: WidgetDataSource = Field(default_factory=WidgetDataSource)
    config: dict[str, Any] = Field(default_factory=dict)
    actions: list[WidgetAction] = Field(default_factory=list, max_length=12)
    permissions: WidgetPermissions = Field(default_factory=WidgetPermissions)
    createdAt: str = ""
    updatedAt: str = ""

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not re.fullmatch(r"[a-zA-Z0-9_-]{3,90}", value):
            raise ValueError("Widget id must contain only letters, numbers, _ or -.")
        return value


class CanvasState(BaseModel):
    zoom: float = Field(1.0, ge=0.35, le=2.5)
    offset: dict[str, int] = Field(default_factory=lambda: {"x": 0, "y": 0})
    grid: bool = True


class WidgetLayoutDocument(BaseModel):
    version: int = SCHEMA_VERSION
    widgets: list[WidgetManifest] = Field(default_factory=list)
    canvas: CanvasState = Field(default_factory=CanvasState)


def utc_stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def validate_manifest(payload: dict[str, Any]) -> WidgetManifest:
    now = utc_stamp()
    payload = dict(payload)
    payload.setdefault("createdAt", now)
    payload["updatedAt"] = now
    return WidgetManifest.model_validate(payload)


async def load_layout(memory: MemoryStore) -> WidgetLayoutDocument:
    saved = await memory.get_preference(WIDGET_LAYOUT_KEY)
    if isinstance(saved, dict):
        try:
            return WidgetLayoutDocument.model_validate(saved)
        except ValidationError:
            pass
    return WidgetLayoutDocument()


async def save_layout(memory: MemoryStore, layout: WidgetLayoutDocument) -> WidgetLayoutDocument:
    await memory.set_preference(WIDGET_LAYOUT_KEY, layout.model_dump())
    return layout


def safe_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def manifest_from_intent(command: str, next_index: int = 1) -> WidgetManifest:
    text = " ".join(command.lower().split())
    base_x = 96 + (next_index % 4) * 34
    base_y = 96 + (next_index % 5) * 30

    def make(widget_type: WidgetType, title: str, description: str, config: dict[str, Any], tool: str | None = None) -> WidgetManifest:
        source: dict[str, Any] = {"type": "mock"}
        if tool:
            source = {"type": "internal_tool", "toolName": tool, "params": {}}
        return validate_manifest(
            {
                "id": f"widget_{re.sub(r'[^a-z0-9]+', '_', title.lower()).strip('_')}_{uuid.uuid4().hex[:6]}",
                "type": widget_type,
                "title": title,
                "description": description,
                "layout": {"x": base_x, "y": base_y, "w": config.pop("_w", 420), "h": config.pop("_h", 280), "zIndex": next_index + 2},
                "refreshInterval": int(config.pop("_refresh", 0)),
                "dataSource": source,
                "config": config,
                "permissions": {"canRead": True, "canWrite": False, "canExecuteActions": True},
            }
        )

    refresh_match = re.search(r"cada\s+(\d+)\s*seg", text)
    refresh = int(refresh_match.group(1)) * 1000 if refresh_match else 0

    if "logs" in text or "log" in text:
        return make("log_viewer", "Logs de JARVIS", "Ultimas acciones, errores y comandos.", {"_w": 520, "_h": 360, "_refresh": refresh, "limit": 30}, "get_recent_logs")
    if "red" in text or "network" in text:
        return make(
            "metric_grid",
            "Monitor de red",
            "Latencia, trafico y estado del enlace.",
            {
                "_w": 440,
                "_h": 270,
                "_refresh": refresh or 5000,
                "metrics": [
                    {"label": "Latencia", "key": "latency", "suffix": "ms"},
                    {"label": "Descarga", "key": "download", "suffix": "Mbps"},
                    {"label": "Subida", "key": "upload", "suffix": "Mbps"},
                    {"label": "Estado", "key": "status"},
                ],
            },
            "get_network_status",
        )
    if "servicio" in text or "moodle" in text or "notebook" in text or "n8n" in text:
        return make("service_monitor", "Estado de servicios", "Servicios clave del entorno.", {"_w": 500, "_h": 340, "_refresh": refresh or 10000}, "get_service_status")
    if "url" in text or "preview" in text or "previsual" in text:
        return make("web_preview", "Preview de URL", "Previsualizacion segura de enlaces http/https.", {"_w": 560, "_h": 390, "url": "https://example.com"})
    if "tarea" in text or "checklist" in text:
        return make("checklist", "Checklist", "Lista de tareas editable.", {"_w": 430, "_h": 330, "items": [{"id": "t1", "text": "Primera tarea", "done": False}]})
    if "tabla" in text:
        return make("table", "Tabla de datos", "Tabla configurable con filas mock.", {"_w": 540, "_h": 320, "columns": ["Nombre", "Estado", "Detalle"], "rows": [["Hermes", "Mock", "Preparado"], ["JARVIS", "Online", "Local"]]})
    if "formulario" in text or "form" in text:
        return make("form", "Formulario", "Captura datos manuales.", {"_w": 430, "_h": 330, "fields": [{"id": "url", "label": "URL", "type": "url"}, {"id": "notes", "label": "Notas", "type": "textarea"}]})
    if "comando" in text or "accion" in text or "acción" in text:
        manifest = make("command_panel", "Panel de comandos", "Acciones rapidas con confirmacion.", {"_w": 460, "_h": 300})
        manifest.actions = [
            WidgetAction(id="sync_workspace", label="Sync workspace", toolName="sync_workspace", dangerLevel="low"),
            WidgetAction(id="restart_service", label="Reiniciar servicio", toolName="restart_service", requiresConfirmation=True, dangerLevel="medium"),
        ]
        return manifest
    if "chat" in text:
        return make("chat_panel", "Chat JARVIS", "Panel conversacional local.", {"_w": 520, "_h": 380})
    if "cpu" in text or "ram" in text or "sistema" in text or "dashboard" in text or "metric" in text:
        return make(
            "metric_grid",
            "Monitor del sistema",
            "CPU, RAM, disco y estado general.",
            {
                "_w": 480,
                "_h": 300,
                "_refresh": refresh or 5000,
                "metrics": [
                    {"label": "CPU", "key": "cpu", "suffix": "%"},
                    {"label": "RAM", "key": "ram", "suffix": "%"},
                    {"label": "Disco", "key": "disk", "suffix": "%"},
                    {"label": "Estado", "key": "status"},
                ],
            },
            "get_cpu_ram_status",
        )
    return make("markdown", "Nota de JARVIS", "Panel markdown seguro.", {"_w": 420, "_h": 260, "markdown": f"### Solicitud\n{command}"})
