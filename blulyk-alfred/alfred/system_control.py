from __future__ import annotations

import time
from typing import Any

from alfred.config import Settings


def host_shell(settings: Settings, command: str, confirm: bool = False, timeout: int = 45) -> dict[str, Any]:
    if not settings.system_control:
        return {"ok": False, "error": "System control disabled. Set JARVIS_SYSTEM_CONTROL=true."}
    if not confirm:
        return {
            "ok": False,
            "error": "Host shell requires confirm=true because it can change the Umbrel host.",
        }
    command = command.strip()
    if not command:
        return {"ok": False, "error": "Empty command."}

    timeout = max(3, min(int(timeout or 45), 180))
    started = time.time()
    try:
        import docker

        client = docker.from_env()
        container = client.containers.run(
            settings.host_shell_image,
            [
                "chroot",
                "/host",
                "/bin/sh",
                "-lc",
                command,
            ],
            remove=True,
            privileged=True,
            network_mode="host",
            volumes={"/": {"bind": "/host", "mode": "rw"}},
            stdout=True,
            stderr=True,
            detach=True,
        )
        try:
            result = container.wait(timeout=timeout)
            output = container.logs(stdout=True, stderr=True)
        finally:
            try:
                container.remove(force=True)
            except Exception:
                pass
        text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else str(output)
        return {
            "ok": int(result.get("StatusCode", 1)) == 0,
            "command": command,
            "exit_code": result.get("StatusCode"),
            "duration_seconds": round(time.time() - started, 2),
            "output": text[-12000:],
        }
    except Exception as exc:
        return {
            "ok": False,
            "command": command,
            "duration_seconds": round(time.time() - started, 2),
            "error": str(exc),
        }


def host_auth_journal(settings: Settings, lines: int = 3000) -> dict[str, Any]:
    if not settings.system_control:
        return {"ok": False, "error": "System control disabled. Set JARVIS_SYSTEM_CONTROL=true."}
    line_count = max(100, min(int(lines or 3000), 10000))
    command = f"journalctl -n {line_count} --no-pager | grep -Ei 'sshd|sudo|authentication|failed password|invalid user' || true"
    return host_shell(settings, command, confirm=True, timeout=45)
