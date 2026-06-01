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


class WidgetGenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=1000)
    existing_widgets: list[str] = Field(default_factory=list, max_length=30)


class GoogleSettingsRequest(BaseModel):
    api_key: str = Field(min_length=20, max_length=400)
    model: str | None = Field(default=None, max_length=80)


class ChatGPTOAuthSettingsRequest(BaseModel):
    client_id: str = Field(min_length=1, max_length=300)
    client_secret: str = Field(min_length=1, max_length=600)
    authorization_url: str = Field(min_length=8, max_length=1000)
    token_url: str = Field(min_length=8, max_length=1000)
    scope: str = Field(default="", max_length=500)


class CodexAuthImportRequest(BaseModel):
    auth_json: str = Field(min_length=20, max_length=20000)
