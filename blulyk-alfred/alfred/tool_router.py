from typing import Any

from alfred.asset_registry import AssetRegistry
from alfred.config import Settings
from alfred.docker_control import docker_summary, restart_container
from alfred.memory import MemoryStore
from alfred.threats import scan_auth_log
from alfred.vitals import vitals_payload


class ToolRouter:
    def __init__(self, settings: Settings, memory: MemoryStore, assets: AssetRegistry) -> None:
        self.settings = settings
        self.memory = memory
        self.assets = assets

    def catalog(self) -> list[dict[str, Any]]:
        return [
            {"name": "vitals.report", "arguments": {}},
            {"name": "threats.scan", "arguments": {}},
            {"name": "docker.summary", "arguments": {}},
            {"name": "docker.restart", "arguments": {"name": "container-name"}},
            {"name": "memory.incidents", "arguments": {"limit": 10}},
            {
                "name": "asset.command",
                "arguments": {
                    "asset_id": "main-pc",
                    "action": "ping|process_audit|launch|lock|sleep",
                    "payload": {},
                },
            },
        ]

    async def execute(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        args = arguments or {}
        if name == "vitals.report":
            return {"ok": True, "result": vitals_payload(self.settings)}
        if name == "threats.scan":
            return {"ok": True, "result": scan_auth_log(self.settings.auth_log_path)}
        if name == "docker.summary":
            return {"ok": True, "result": docker_summary(self.settings)}
        if name == "docker.restart":
            return {"ok": True, "result": restart_container(self.settings, str(args.get("name", "")))}
        if name == "memory.incidents":
            limit = int(args.get("limit", 10))
            return {"ok": True, "result": await self.memory.recent_incidents(limit)}
        if name == "asset.command":
            result = await self.assets.send_command(
                str(args["asset_id"]),
                str(args["action"]),
                args.get("payload") or {},
            )
            return {"ok": True, "result": result}
        return {"ok": False, "error": f"Unknown tool {name!r}."}
