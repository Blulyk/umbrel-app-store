import asyncio
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from cryptography.fernet import Fernet
from fastapi import WebSocket


@dataclass
class AssetConnection:
    asset_id: str
    websocket: WebSocket
    connected_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())


class AssetRegistry:
    def __init__(self, bridge_key: str) -> None:
        self._fernet = Fernet(bridge_key.encode())
        self._connections: dict[str, AssetConnection] = {}
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, asset_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections[asset_id] = AssetConnection(asset_id=asset_id, websocket=websocket)

    async def disconnect(self, asset_id: str) -> None:
        async with self._lock:
            self._connections.pop(asset_id, None)

    async def list_assets(self) -> list[dict[str, str]]:
        async with self._lock:
            return [
                {"asset_id": asset.asset_id, "connected_at": asset.connected_at}
                for asset in self._connections.values()
            ]

    async def send_command(
        self, asset_id: str, action: str, payload: dict[str, Any] | None = None, timeout: float = 15.0
    ) -> dict[str, Any]:
        async with self._lock:
            connection = self._connections.get(asset_id)
        if not connection:
            return {"ok": False, "error": f"Asset {asset_id} is offline."}

        command_id = str(uuid4())
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[command_id] = future
        envelope = self.encrypt({"id": command_id, "action": action, "payload": payload or {}})
        await connection.websocket.send_text(envelope)
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            return {"ok": False, "error": f"Asset {asset_id} failed to respond within {timeout:.0f}s."}
        finally:
            self._pending.pop(command_id, None)

    async def handle_asset_message(self, encrypted_message: str) -> dict[str, Any] | None:
        message = self.decrypt(encrypted_message)
        command_id = message.get("id")
        if not isinstance(command_id, str):
            return message
        future = self._pending.get(command_id)
        if future and not future.done():
            future.set_result(message)
        return message

    def encrypt(self, payload: dict[str, Any]) -> str:
        return self._fernet.encrypt(json.dumps(payload).encode()).decode()

    def decrypt(self, token: str) -> dict[str, Any]:
        return json.loads(self._fernet.decrypt(token.encode()).decode())
