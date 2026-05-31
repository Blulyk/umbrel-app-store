from typing import Any

from alfred.config import Settings


def docker_summary(settings: Settings) -> dict[str, Any]:
    try:
        import docker

        client = docker.from_env()
        containers = client.containers.list(all=True)
        return {
            "available": True,
            "control_enabled": settings.docker_control,
            "containers": [
                {
                    "name": item.name,
                    "image": item.image.tags[0] if item.image.tags else item.image.short_id,
                    "status": item.status,
                }
                for item in containers
            ],
        }
    except Exception as exc:
        return {"available": False, "control_enabled": False, "error": str(exc)}


def restart_container(settings: Settings, name: str) -> dict[str, Any]:
    if not settings.docker_control:
        return {"ok": False, "error": "Docker mutation disabled. Set ALFRED_DOCKER_CONTROL=true."}
    try:
        import docker

        container = docker.from_env().containers.get(name)
        container.restart(timeout=10)
        return {"ok": True, "message": f"Container {name} restarted."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
