import express from "express";
import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || "/data";
const appId = process.env.STEAM_APP_ID || "2327760";
const steamcmd = process.env.STEAMCMD_PATH || "/opt/steamcmd/steamcmd.sh";
const serversDir = path.join(dataDir, "servers");
const backupsDir = path.join(dataDir, "backups");
const dbPath = path.join(dataDir, "servers.json");
const jobs = new Map();
const running = new Map();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

async function ensureDirs() {
  await fs.mkdir(serversDir, { recursive: true });
  await fs.mkdir(backupsDir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadServers() {
  await ensureDirs();
  const servers = await readJson(dbPath, []);
  return servers.map(normalizeServer);
}

async function saveServers(servers) {
  await writeJson(dbPath, servers.map(({ runtime, ...server }) => server));
}

function normalizeServer(server = {}) {
  const id = server.id || randomUUID();
  const base = path.join(serversDir, id);
  return {
    id,
    name: server.name || "Base Nautilus",
    description: server.description || "",
    maxPlayers: Number(server.maxPlayers || 4),
    gamePort: Number(server.gamePort || 27015),
    queryPort: Number(server.queryPort || 27016),
    password: server.password || "",
    branch: server.branch || "public",
    launchArgs: server.launchArgs || "",
    executablePath: server.executablePath || "",
    configText: server.configText || defaultConfig(server),
    createdAt: server.createdAt || new Date().toISOString(),
    updatedAt: server.updatedAt || new Date().toISOString(),
    installDir: server.installDir || path.join(base, "game"),
    logPath: server.logPath || path.join(base, "logs", "server.log")
  };
}

function defaultConfig(server = {}) {
  return [
    "# Subnautica 2 dedicated server configuration",
    "# Ruta esperada por la documentacion: Subnautica2_Data/Config/Internal_Server.cfg",
    "# Algunas claves pueden cambiar durante Early Access. Edita libremente este archivo.",
    `ServerName=${server.name || "Base Nautilus"}`,
    `MaxPlayers=${server.maxPlayers || 4}`,
    `GamePort=${server.gamePort || 27015}`,
    `QueryPort=${server.queryPort || 27016}`,
    server.password ? `Password=${server.password}` : "# Password=",
    "Public=true",
    "AutoSave=true"
  ].join("\n");
}

async function findServer(id) {
  const servers = await loadServers();
  const server = servers.find((item) => item.id === id);
  return { servers, server };
}

async function persistConfig(server) {
  const configDir = path.join(server.installDir, "Subnautica2_Data", "Config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "Internal_Server.cfg"), server.configText || defaultConfig(server));
}

function safeArgs(input = "") {
  const args = [];
  const regex = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match;
  while ((match = regex.exec(input))) args.push(match[1] ?? match[2] ?? match[0]);
  return args;
}

async function appendLog(server, text) {
  await fs.mkdir(path.dirname(server.logPath), { recursive: true });
  await fs.appendFile(server.logPath, text);
}

function setJob(id, type, child, server) {
  jobs.set(id, {
    id,
    type,
    serverId: server.id,
    serverName: server.name,
    startedAt: new Date().toISOString(),
    done: false,
    exitCode: null
  });

  child.stdout?.on("data", (chunk) => appendLog(server, chunk.toString()).catch(() => {}));
  child.stderr?.on("data", (chunk) => appendLog(server, chunk.toString()).catch(() => {}));
  child.on("close", (code) => {
    const job = jobs.get(id);
    if (job) {
      job.done = true;
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
    }
  });
}

async function detectExecutable(server) {
  if (server.executablePath) {
    const absolute = path.isAbsolute(server.executablePath)
      ? server.executablePath
      : path.join(server.installDir, server.executablePath);
    if (existsSync(absolute)) return absolute;
  }

  const candidates = [];
  async function walk(dir, depth = 0) {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      if (entry.isFile() && /subnautica.*(server|dedicated)|server.*subnautica|\.x86_64$|\.sh$/i.test(entry.name)) {
        candidates.push(full);
      }
    }
  }
  await walk(server.installDir);
  return candidates[0] || "";
}

function serverRuntime(server) {
  const proc = running.get(server.id);
  const job = [...jobs.values()].reverse().find((item) => item.serverId === server.id && !item.done);
  return {
    state: proc ? "running" : job ? "busy" : "stopped",
    pid: proc?.pid || null,
    job: job || null,
    installed: existsSync(path.join(server.installDir, "steamapps"))
  };
}

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    appId,
    steamcmd: existsSync(steamcmd),
    dataDir,
    platform: `${os.platform()} ${os.arch()}`
  });
});

app.get("/api/servers", async (_req, res) => {
  const servers = await loadServers();
  res.json(servers.map((server) => ({ ...server, runtime: serverRuntime(server) })));
});

app.post("/api/servers", async (req, res) => {
  const servers = await loadServers();
  const server = normalizeServer(req.body);
  server.createdAt = new Date().toISOString();
  server.updatedAt = server.createdAt;
  await fs.mkdir(path.dirname(server.logPath), { recursive: true });
  await persistConfig(server);
  servers.push(server);
  await saveServers(servers);
  res.status(201).json({ ...server, runtime: serverRuntime(server) });
});

app.put("/api/servers/:id", async (req, res) => {
  const { servers, server } = await findServer(req.params.id);
  if (!server) return res.status(404).json({ error: "Servidor no encontrado" });
  if (running.has(server.id)) return res.status(409).json({ error: "Para editar la configuracion, para primero el servidor." });

  Object.assign(server, normalizeServer({ ...server, ...req.body }), { updatedAt: new Date().toISOString() });
  await persistConfig(server);
  await saveServers(servers);
  res.json({ ...server, runtime: serverRuntime(server) });
});

app.delete("/api/servers/:id", async (req, res) => {
  const { servers, server } = await findServer(req.params.id);
  if (!server) return res.status(404).json({ error: "Servidor no encontrado" });
  if (running.has(server.id)) return res.status(409).json({ error: "Para borrar, para primero el servidor." });
  await saveServers(servers.filter((item) => item.id !== server.id));
  await fs.rm(path.join(serversDir, server.id), { recursive: true, force: true });
  res.json({ ok: true });
});

app.post("/api/servers/:id/install", async (req, res) => {
  const { server } = await findServer(req.params.id);
  if (!server) return res.status(404).json({ error: "Servidor no encontrado" });
  if ([...jobs.values()].some((job) => job.serverId === server.id && !job.done)) {
    return res.status(409).json({ error: "Ya hay una tarea en marcha para este servidor." });
  }

  await fs.mkdir(server.installDir, { recursive: true });
  await appendLog(server, `\n[manager] Instalando/actualizando Steam app ${appId} (${new Date().toISOString()})\n`);
  const steamArgs = ["+force_install_dir", server.installDir, "+login", "anonymous"];
  if (server.branch && server.branch !== "public") steamArgs.push("+app_update", appId, "-beta", server.branch, "validate", "+quit");
  else steamArgs.push("+app_update", appId, "validate", "+quit");
  const child = spawn(steamcmd, steamArgs, { cwd: server.installDir, env: process.env });
  const jobId = randomUUID();
  setJob(jobId, "install", child, server);
  res.status(202).json({ jobId });
});

app.post("/api/servers/:id/start", async (req, res) => {
  const { server } = await findServer(req.params.id);
  if (!server) return res.status(404).json({ error: "Servidor no encontrado" });
  if (running.has(server.id)) return res.status(409).json({ error: "Este servidor ya esta arrancado." });
  await persistConfig(server);
  const executable = await detectExecutable(server);
  if (!executable) {
    return res.status(409).json({
      error: "No encuentro el ejecutable del servidor. Instala/actualiza primero o indica la ruta del binario en ajustes avanzados."
    });
  }

  await appendLog(server, `\n[manager] Arrancando ${server.name} con ${executable} (${new Date().toISOString()})\n`);
  const child = spawn(executable, safeArgs(server.launchArgs), {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      SERVER_NAME: server.name,
      GAME_PORT: String(server.gamePort),
      QUERY_PORT: String(server.queryPort),
      MAX_PLAYERS: String(server.maxPlayers)
    }
  });
  running.set(server.id, child);
  child.stdout?.on("data", (chunk) => appendLog(server, chunk.toString()).catch(() => {}));
  child.stderr?.on("data", (chunk) => appendLog(server, chunk.toString()).catch(() => {}));
  child.on("close", (code) => {
    running.delete(server.id);
    appendLog(server, `\n[manager] Proceso finalizado con codigo ${code} (${new Date().toISOString()})\n`).catch(() => {});
  });
  res.json({ ok: true, pid: child.pid });
});

app.post("/api/servers/:id/stop", async (req, res) => {
  const { server } = await findServer(req.params.id);
  if (!server) return res.status(404).json({ error: "Servidor no encontrado" });
  const child = running.get(server.id);
  if (!child) return res.json({ ok: true });
  await appendLog(server, `\n[manager] Parando servidor (${new Date().toISOString()})\n`);
  child.kill("SIGTERM");
  setTimeout(() => {
    if (running.has(server.id)) child.kill("SIGKILL");
  }, 20000);
  res.json({ ok: true });
});

app.get("/api/servers/:id/logs", async (req, res) => {
  const { server } = await findServer(req.params.id);
  if (!server) return res.status(404).json({ error: "Servidor no encontrado" });
  const max = Math.min(Number(req.query.max || 50000), 250000);
  try {
    const stat = await fs.stat(server.logPath);
    const handle = await fs.open(server.logPath, "r");
    const length = Math.min(stat.size, max);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    await handle.close();
    res.type("text/plain").send(buffer.toString());
  } catch {
    res.type("text/plain").send("");
  }
});

app.get("/api/jobs", (_req, res) => {
  res.json([...jobs.values()].slice(-20).reverse());
});

app.get("/api/servers/:id/backups", async (req, res) => {
  const { server } = await findServer(req.params.id);
  if (!server) return res.status(404).json({ error: "Servidor no encontrado" });
  const dir = path.join(backupsDir, server.id);
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const backups = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const full = path.join(dir, entry.name);
    const stat = await fs.stat(full);
    return { name: entry.name, size: stat.size, createdAt: stat.birthtime.toISOString() };
  }));
  res.json(backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post("/api/servers/:id/backups", async (req, res) => {
  const { server } = await findServer(req.params.id);
  if (!server) return res.status(404).json({ error: "Servidor no encontrado" });
  const dir = path.join(backupsDir, server.id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${server.name.replace(/[^a-z0-9]+/gi, "-")}.tar.gz`);
  const output = createWriteStream(file);
  const child = spawn("tar", ["-czf", "-", "-C", path.join(serversDir, server.id), "."], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(output);
  child.stderr.on("data", (chunk) => appendLog(server, chunk.toString()).catch(() => {}));
  child.on("close", async (code) => {
    await appendLog(server, `[manager] Backup ${code === 0 ? "creado" : "fallido"}: ${path.basename(file)}\n`);
  });
  res.status(202).json({ name: path.basename(file) });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

await ensureDirs();
app.listen(port, () => {
  console.log(`Subnautica 2 Server Manager listening on ${port}`);
});
