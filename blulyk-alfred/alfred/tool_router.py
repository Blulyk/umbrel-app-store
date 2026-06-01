from typing import Any

from alfred.asset_registry import AssetRegistry
from alfred.config import Settings
from alfred.docker_control import docker_summary, restart_container
from alfred.memory import MemoryStore
from alfred.system_control import host_auth_journal, host_shell
from alfred.threats import scan_auth_log, scan_auth_text
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
            {"name": "jarvis.self_status", "arguments": {}},
            {"name": "jarvis.self_restart", "arguments": {"confirm": True}},
            {
                "name": "system.host_shell",
                "arguments": {
                    "command": "id && hostnamectl",
                    "confirm": True,
                    "timeout": 45,
                },
            },
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
            result = scan_auth_log(self.settings.auth_log_path)
            if result.get("status") == "Unavailable" and self.settings.system_control:
                journal = host_auth_journal(self.settings)
                if journal.get("ok"):
                    result = scan_auth_text(str(journal.get("output", "")).splitlines())
                    result["source"] = "host-journal"
                else:
                    result["journal_fallback_error"] = journal.get("error")
            return {"ok": True, "result": result}
        if name == "docker.summary":
            return {"ok": True, "result": docker_summary(self.settings)}
        if name == "docker.restart":
            result = restart_container(self.settings, str(args.get("name", "")))
            await self.memory.record_incident("info", "docker-control", f"docker.restart {args.get('name', '')}", result)
            return {"ok": True, "result": result}
        if name == "jarvis.self_status":
            return {
                "ok": True,
                "result": {
                    "app": "blulyk-alfred",
                    "container": "blulyk-alfred_web_1",
                    "docker": docker_summary(self.settings),
                    "control": {
                        "docker_control": self.settings.docker_control,
                        "system_control": self.settings.system_control,
                        "public_port": getattr(self.settings, "public_port", 8099),
                    },
                },
            }
        if name == "jarvis.self_restart":
            if not bool(args.get("confirm", False)):
                return {"ok": True, "result": {"ok": False, "error": "Self restart requires confirm=true."}}
            result = restart_container(self.settings, "blulyk-alfred_web_1")
            await self.memory.record_incident("warning", "self-control", "jarvis.self_restart", result)
            return {"ok": True, "result": result}
        if name == "system.host_shell":
            result = host_shell(
                self.settings,
                str(args.get("command", "")),
                bool(args.get("confirm", False)),
                int(args.get("timeout", 45)),
            )
            await self.memory.record_incident(
                "warning" if result.get("ok") else "info",
                "system-control",
                f"system.host_shell {str(args.get('command', ''))[:120]}",
                result,
            )
            return {"ok": True, "result": result}
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
