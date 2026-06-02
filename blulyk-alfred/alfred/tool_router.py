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
            {"name": "get_system_status", "arguments": {}},
            {"name": "get_network_status", "arguments": {}},
            {"name": "get_cpu_ram_status", "arguments": {}},
            {"name": "get_storage_status", "arguments": {}},
            {"name": "get_recent_logs", "arguments": {"limit": 20}},
            {"name": "get_service_status", "arguments": {}},
            {"name": "restart_service", "arguments": {"name": "service-name", "confirm": True}},
            {"name": "sync_workspace", "arguments": {}},
            {"name": "get_calendar_preview", "arguments": {}},
            {"name": "get_assets_list", "arguments": {}},
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
        if name == "get_system_status":
            vitals = vitals_payload(self.settings)
            docker = docker_summary(self.settings)
            return {"ok": True, "result": {"mock": False, "vitals": vitals, "docker": docker}}
        if name == "get_cpu_ram_status":
            vitals = vitals_payload(self.settings)
            return {
                "ok": True,
                "result": {
                    "mock": False,
                    "cpu": round(float(vitals.get("cpu_percent") or 0), 1),
                    "ram": round(float(vitals.get("ram_percent") or 0), 1),
                    "disk": round(float(vitals.get("disk_percent") or 0), 1),
                    "status": vitals.get("status", "Unknown"),
                },
            }
        if name == "get_storage_status":
            vitals = vitals_payload(self.settings)
            return {"ok": True, "result": {"mock": False, "disk": vitals.get("disk_percent"), "status": vitals.get("status")}}
        if name == "get_network_status":
            return {
                "ok": True,
                "result": {
                    "mock": True,
                    "latency": 22,
                    "download": 312,
                    "upload": 94,
                    "status": "mock-ready",
                },
            }
        if name == "get_recent_logs":
            limit = int(args.get("limit", 20))
            return {"ok": True, "result": await self.memory.recent_audit(limit)}
        if name == "get_service_status":
            docker = docker_summary(self.settings)
            containers = docker.get("containers", []) if docker.get("available") else []
            names = ["JARVIS", "Hermes", "Moodle", "NotebookLM", "n8n", "servidor local"]
            services = []
            for service in names:
                match = next((item for item in containers if service.lower() in str(item.get("name", "")).lower()), None)
                services.append(
                    {
                        "name": service,
                        "status": match.get("status") if match else "mock-ready",
                        "detail": match.get("image") if match else "Prepared connector",
                        "mock": match is None,
                    }
                )
            return {"ok": True, "result": {"services": services}}
        if name == "restart_service":
            if not bool(args.get("confirm")):
                return {"ok": False, "error": "restart_service requires confirm=true."}
            return {"ok": True, "result": {"mock": True, "message": f"Restart prepared for {args.get('name', 'service')}."}}
        if name == "sync_workspace":
            return {"ok": True, "result": {"mock": True, "message": "Workspace sync hook prepared."}}
        if name == "get_calendar_preview":
            return {"ok": True, "result": {"mock": True, "events": [{"title": "Revision JARVIS", "when": "Hoy"}, {"title": "Automatizaciones", "when": "Manana"}]}}
        if name == "get_assets_list":
            return {"ok": True, "result": await self.assets.list_assets()}
        if name == "asset.command":
            result = await self.assets.send_command(
                str(args["asset_id"]),
                str(args["action"]),
                args.get("payload") or {},
            )
            return {"ok": True, "result": result}
        return {"ok": False, "error": f"Unknown tool {name!r}."}
