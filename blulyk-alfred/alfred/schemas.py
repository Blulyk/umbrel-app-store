from typing import Any, Literal

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)


class AssetCommandRequest(BaseModel):
    action: Literal["ping", "process_audit", "launch", "lock", "sleep"]
    payload: dict[str, Any] = Field(default_factory=dict)


class ToolCallRequest(BaseModel):
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class WidgetCommandRequest(BaseModel):
    command: str = Field(min_length=1, max_length=2000)
    selected_widget_id: str | None = Field(default=None, max_length=90)


class WidgetManifestRequest(BaseModel):
    manifest: dict[str, Any]


class WidgetPatchRequest(BaseModel):
    patch: dict[str, Any]


class CanvasImportRequest(BaseModel):
    layout: dict[str, Any]


class WidgetActionRequest(BaseModel):
    action_id: str = Field(min_length=1, max_length=80)
    confirm: bool = False
