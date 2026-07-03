import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3018);
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const APP_DATA_ROOT = process.env.UMBREL_APP_DATA_ROOT || "/umbrel/app-data";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function dockerRequest(method, dockerPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = httpRequest(
      {
        socketPath: DOCKER_SOCKET,
        path: dockerPath,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString("utf8");
          if (res.statusCode >= 400) {
            reject(new Error(text || `Docker API returned ${res.statusCode}`));
            return;
          }
          const contentType = res.headers["content-type"] || "";
          if (contentType.includes("application/json")) {
            resolve(text ? JSON.parse(text) : null);
          } else {
            resolve(text);
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res, error, status = 500) {
  sendJson(res, status, { error: error.message || String(error) });
}

function containerProject(container) {
  const labels = container.Config?.Labels || container.Labels || {};
  const project = labels["com.docker.compose.project"];
  if (project) return project;

  const rawName = (container.Name || container.Names?.[0] || "").replace(/^\//, "");
  const match = rawName.match(/^(.+?)_(?:web|server|app_proxy|db|redis|worker|database)[_-]?\d*$/);
  return match?.[1] || rawName.split("_")[0] || "";
}

function safeAppPath(project, filename) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(project)) return null;
  return path.join(APP_DATA_ROOT, project, filename);
}

function simplifyContainer(container) {
  const names = container.Names || [];
  const name = container.Name?.replace(/^\//, "") || names[0]?.replace(/^\//, "") || container.Id;
  const ports = (container.Ports || []).map((port) => ({
    privatePort: port.PrivatePort,
    publicPort: port.PublicPort || null,
    type: port.Type,
    ip: port.IP || "",
  }));

  return {
    id: container.Id,
    name,
    image: container.Image,
    imageId: container.ImageID,
    command: container.Command,
    created: container.Created,
    state: container.State,
    status: container.Status,
    ports,
    project: container.Labels?.["com.docker.compose.project"] || name.split("_")[0],
  };
}

async function getContainerDetail(id) {
  const container = await dockerRequest("GET", `/containers/${encodeURIComponent(id)}/json`);
  const project = containerProject(container);
  const composePath = project ? safeAppPath(project, "docker-compose.yml") : null;
  const appManifestPath = project ? safeAppPath(project, "umbrel-app.yml") : null;
  const settingsPath = project ? safeAppPath(project, "settings.yml") : null;

  const files = {};
  for (const [key, filePath] of Object.entries({
    compose: composePath,
    manifest: appManifestPath,
    settings: settingsPath,
  })) {
    if (filePath && existsSync(filePath)) {
      files[key] = await readFile(filePath, "utf8");
    }
  }

  return {
    id: container.Id,
    name: container.Name.replace(/^\//, ""),
    project,
    image: container.Config.Image,
    entrypoint: container.Config.Entrypoint,
    command: container.Config.Cmd,
    created: container.Created,
    state: container.State,
    restartPolicy: container.HostConfig.RestartPolicy,
    networkMode: container.HostConfig.NetworkMode,
    ports: container.NetworkSettings.Ports || {},
    mounts: container.Mounts || [],
    env: container.Config.Env || [],
    labels: container.Config.Labels || {},
    networks: container.NetworkSettings.Networks || {},
    files,
  };
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/containers") {
    const containers = await dockerRequest("GET", "/containers/json?all=1");
    sendJson(res, 200, containers.map(simplifyContainer));
    return;
  }

  const match = url.pathname.match(/^\/api\/containers\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    sendJson(res, 404, { error: "API route not found" });
    return;
  }

  const id = match[1];
  const action = match[2] || "detail";

  if (req.method === "GET" && action === "detail") {
    sendJson(res, 200, await getContainerDetail(id));
    return;
  }

  if (req.method === "GET" && action === "logs") {
    const logs = await dockerRequest(
      "GET",
      `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=400&timestamps=1`,
    );
    sendJson(res, 200, { logs: String(logs).replace(/\u0000/g, "") });
    return;
  }

  if (req.method === "POST" && ["start", "stop", "restart"].includes(action)) {
    await dockerRequest("POST", `/containers/${encodeURIComponent(id)}/${action}`);
    sendJson(res, 200, { ok: true, action });
    return;
  }

  sendJson(res, 404, { error: "Unsupported container action" });
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, "public", safePath);
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600",
    });
    res.end(body);
  } catch {
    const body = await readFile(path.join(__dirname, "public", "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    sendError(res, error);
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Umbrel Container Studio listening on ${PORT}`);
});
