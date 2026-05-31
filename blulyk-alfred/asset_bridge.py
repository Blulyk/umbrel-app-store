import argparse
import asyncio
import json
import os
import platform
import subprocess
from pathlib import Path
from typing import Any

import psutil
import websockets
from cryptography.fernet import Fernet


ALLOWED_ACTIONS = {"ping", "process_audit", "launch", "lock", "sleep"}


class AssetBridge:
    def __init__(self, server: str, asset_id: str, key: str, config_path: str) -> None:
        self.server = server
        self.asset_id = asset_id
        self.fernet = Fernet(key.encode())
        self.config = self._load_config(config_path)

    async def run_forever(self) -> None:
        url = f"{self.server}?asset_id={self.asset_id}"
        while True:
            try:
                async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
                    await ws.send(self.encrypt({"event": "asset_ready", "asset_id": self.asset_id}))
                    async for encrypted in ws:
                        command = self.decrypt(encrypted)
                        result = await self.handle_command(command)
                        await ws.send(self.encrypt(result))
            except Exception as exc:
                print(f"ALFRED bridge offline: {exc}. Retrying in 5s.")
                await asyncio.sleep(5)

    async def handle_command(self, command: dict[str, Any]) -> dict[str, Any]:
        command_id = command.get("id")
        action = command.get("action")
        payload = command.get("payload") or {}
        if action not in ALLOWED_ACTIONS:
            return {"id": command_id, "ok": False, "error": f"Action {action!r} is not authorised."}

        try:
            if action == "ping":
                data = {"hostname": platform.node(), "platform": platform.platform()}
            elif action == "process_audit":
                data = await asyncio.to_thread(process_audit)
            elif action == "launch":
                data = await asyncio.to_thread(self.launch, str(payload.get("app", "")))
            elif action == "lock":
                data = await asyncio.to_thread(lock_workstation)
            elif action == "sleep":
                data = await asyncio.to_thread(sleep_machine)
            else:
                data = {"message": "No operation performed."}
            return {"id": command_id, "ok": True, "data": data}
        except Exception as exc:
            return {"id": command_id, "ok": False, "error": str(exc)}

    def launch(self, app_name: str) -> dict[str, str]:
        allowed_apps = self.config.get("allowed_apps", {})
        executable = allowed_apps.get(app_name)
        if not executable:
            raise ValueError(f"Application {app_name!r} is not in the launch allowlist.")
        subprocess.Popen([executable], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"launched": app_name}

    def encrypt(self, payload: dict[str, Any]) -> str:
        return self.fernet.encrypt(json.dumps(payload).encode()).decode()

    def decrypt(self, token: str) -> dict[str, Any]:
        return json.loads(self.fernet.decrypt(token.encode()).decode())

    @staticmethod
    def _load_config(path: str) -> dict[str, Any]:
        config_path = Path(path)
        if not config_path.exists():
            return {"allowed_apps": {}}
        return json.loads(config_path.read_text(encoding="utf-8"))


def process_audit(limit: int = 25) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for proc in psutil.process_iter(["pid", "name", "username", "cpu_percent", "memory_percent"]):
        try:
            item = proc.info
            rows.append(
                {
                    "pid": item["pid"],
                    "name": item["name"],
                    "username": item.get("username"),
                    "cpu_percent": item.get("cpu_percent") or 0.0,
                    "memory_percent": round(item.get("memory_percent") or 0.0, 2),
                }
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return sorted(rows, key=lambda row: row["memory_percent"], reverse=True)[:limit]


def lock_workstation() -> dict[str, str]:
    system = platform.system()
    if system == "Windows":
        subprocess.run(["rundll32.exe", "user32.dll,LockWorkStation"], check=True)
    elif system == "Darwin":
        subprocess.run(
            ["/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession", "-suspend"],
            check=True,
        )
    else:
        subprocess.run(["loginctl", "lock-session"], check=True)
    return {"state": "locked"}


def sleep_machine() -> dict[str, str]:
    system = platform.system()
    if system == "Windows":
        subprocess.run(["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"], check=True)
    elif system == "Darwin":
        subprocess.run(["pmset", "sleepnow"], check=True)
    else:
        subprocess.run(["systemctl", "suspend"], check=True)
    return {"state": "sleep_requested"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ALFRED encrypted remote asset bridge.")
    parser.add_argument("--server", default=os.getenv("ALFRED_ASSET_SERVER", "ws://localhost:8080/ws/asset"))
    parser.add_argument("--asset-id", default=os.getenv("ALFRED_ASSET_ID", platform.node()))
    parser.add_argument("--key", default=os.getenv("ALFRED_BRIDGE_KEY"), required=not os.getenv("ALFRED_BRIDGE_KEY"))
    parser.add_argument("--config", default=os.getenv("ALFRED_ASSET_CONFIG", "asset_bridge_config.json"))
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    bridge = AssetBridge(args.server, args.asset_id, args.key, args.config)
    asyncio.run(bridge.run_forever())
