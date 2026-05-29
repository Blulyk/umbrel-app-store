import asyncio
from collections import deque
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
HERMES_BIN = "/opt/hermes/.venv/bin/hermes"

COMMANDS = {
    "chat": ["/bin/bash", "-c", f"{HERMES_BIN} --continue || {HERMES_BIN}"],
    "control": [HERMES_BIN, "--tui"],
    "setup": [HERMES_BIN, "setup"],
    "model": [HERMES_BIN, "model"],
    "status": [HERMES_BIN, "status"],
    "shell": ["/bin/bash"],
}

SESSIONS = {}
BUFFER_LIMIT = 256 * 1024


def set_winsize(fd, rows, cols):
    winsize = struct.pack("HHHH", int(rows), int(cols), 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


class PtySession:
    def __init__(self, mode, command):
        self.mode = mode
        self.command = command
        self.pid = None
        self.fd = None
        self.clients = set()
        self.buffer = deque()
        self.buffer_size = 0
        self.reader_task = None

    def append_buffer(self, data):
        self.buffer.append(data)
        self.buffer_size += len(data)
        while self.buffer_size > BUFFER_LIMIT and self.buffer:
            removed = self.buffer.popleft()
            self.buffer_size -= len(removed)

    def is_alive(self):
        if self.pid is None:
            return False
        try:
            os.kill(self.pid, 0)
            return True
        except ProcessLookupError:
            return False

    def start(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["HERMES_HOME"] = str(DATA_DIR)
        env["HOME"] = str(DATA_DIR)
        env["PATH"] = f"/opt/hermes/.venv/bin:/opt/data/.local/bin:{env.get('PATH', '')}"
        env.setdefault("TERM", "xterm-256color")
        env.setdefault("COLORTERM", "truecolor")

        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(str(DATA_DIR))
            os.execvpe(self.command[0], self.command, env)

        set_winsize(self.fd, 32, 110)
        self.reader_task = asyncio.create_task(self.read_pty())

    async def read_pty(self):
        loop = asyncio.get_running_loop()
        try:
            while True:
                data = await loop.run_in_executor(None, os.read, self.fd, 4096)
                if not data:
                    break
                self.append_buffer(data)
                stale = []
                for client in self.clients:
                    try:
                        await client.send_bytes(data)
                    except Exception:
                        stale.append(client)
                for client in stale:
                    self.clients.discard(client)
        except Exception:
            pass
        finally:
            self.stop(clear_clients=False)

    def write(self, data):
        if self.fd is not None and self.is_alive():
            os.write(self.fd, data.encode())

    def resize(self, rows, cols):
        if self.fd is not None and self.is_alive():
            set_winsize(self.fd, rows, cols)

    def stop(self, clear_clients=True):
        current_task = asyncio.current_task()
        if self.reader_task and self.reader_task is not current_task and not self.reader_task.done():
            self.reader_task.cancel()
        self.reader_task = None
        if self.pid is not None:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
        self.pid = None
        self.fd = None
        if clear_clients:
            self.clients.clear()

    async def attach(self, ws):
        self.clients.add(ws)
        for data in self.buffer:
            await ws.send_bytes(data)


def get_session(mode):
    command = COMMANDS.get(mode, COMMANDS["chat"])
    session = SESSIONS.get(mode)
    if session is None:
        session = PtySession(mode, command)
        SESSIONS[mode] = session
    if not session.is_alive():
        session.start()
    return session


async def websocket(request):
    ws = web.WebSocketResponse(heartbeat=25)
    await ws.prepare(request)

    mode = request.query.get("mode", "chat")
    session = get_session(mode)
    await session.attach(ws)

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                payload = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            if payload.get("type") == "input":
                session.write(payload.get("data", ""))
            elif payload.get("type") == "resize":
                session.resize(payload.get("rows", 32), payload.get("cols", 110))
    finally:
        session.clients.discard(ws)

    return ws


async def restart_session(request):
    mode = request.query.get("mode", "chat")
    session = SESSIONS.get(mode)
    if session is not None:
        session.stop()
        session.buffer.clear()
        session.buffer_size = 0
    return web.json_response({"ok": True, "mode": mode})


async def health(_request):
    return web.json_response({"ok": True, "dataDir": str(DATA_DIR)})


async def index(_request):
    return web.FileResponse(PUBLIC / "index.html")


app = web.Application()
app.router.add_get("/", index)
app.router.add_get("/health", health)
app.router.add_get("/ws", websocket)
app.router.add_post("/session/restart", restart_session)
app.router.add_static("/", PUBLIC, show_index=False)

web.run_app(app, host="0.0.0.0", port=PORT)
