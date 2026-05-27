import asyncio
import fcntl
import json
import os
import pty
import signal
import struct
import termios
from pathlib import Path

from aiohttp import web, WSMsgType

ROOT = Path(__file__).parent
PUBLIC = ROOT / "public"
DATA_DIR = Path(os.environ.get("HERMES_HOME", "/opt/data"))
PORT = int(os.environ.get("PORT", "9119"))

COMMANDS = {
    "chat": ["hermes"],
    "setup": ["hermes", "setup"],
    "model": ["hermes", "model"],
    "status": ["hermes", "status"],
    "shell": ["/bin/bash"],
}


def set_winsize(fd, rows, cols):
    winsize = struct.pack("HHHH", int(rows), int(cols), 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


async def websocket(request):
    ws = web.WebSocketResponse(heartbeat=25)
    await ws.prepare(request)

    mode = request.query.get("mode", "chat")
    command = COMMANDS.get(mode, COMMANDS["chat"])
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["HERMES_HOME"] = str(DATA_DIR)
    env["HOME"] = str(DATA_DIR)
    env["PATH"] = f"/opt/hermes/.venv/bin:/opt/data/.local/bin:{env.get('PATH', '')}"
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(str(DATA_DIR))
        os.execvpe(command[0], command, env)

    set_winsize(fd, 32, 110)
    loop = asyncio.get_running_loop()
    closed = asyncio.Event()

    async def read_pty():
        try:
            while not closed.is_set():
                data = await loop.run_in_executor(None, os.read, fd, 4096)
                if not data:
                    break
                await ws.send_bytes(data)
        except Exception:
            pass
        finally:
            closed.set()

    reader_task = asyncio.create_task(read_pty())

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                payload = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            if payload.get("type") == "input":
                os.write(fd, payload.get("data", "").encode())
            elif payload.get("type") == "resize":
                set_winsize(fd, payload.get("rows", 32), payload.get("cols", 110))
    finally:
        closed.set()
        reader_task.cancel()
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass

    return ws


async def health(_request):
    return web.json_response({"ok": True, "dataDir": str(DATA_DIR)})


async def index(_request):
    return web.FileResponse(PUBLIC / "index.html")


app = web.Application()
app.router.add_get("/", index)
app.router.add_get("/health", health)
app.router.add_get("/ws", websocket)
app.router.add_static("/", PUBLIC, show_index=False)

web.run_app(app, host="0.0.0.0", port=PORT)
