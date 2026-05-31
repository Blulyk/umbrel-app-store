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
