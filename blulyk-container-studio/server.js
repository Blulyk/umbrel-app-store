import { createServer, request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3018);
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const APP_DATA_ROOT = process.env.UMBREL_APP_DATA_ROOT || "/umbrel/app-data";
const HOST_APP_DATA_ROOT = process.env.HOST_UMBREL_APP_DATA_ROOT || "/home/umbrel/umbrel/app-data";

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
          resolve(contentType.includes("application/json") ? (text ? JSON.parse(text) : null) : text);
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120000, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function safeAppId(appId) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(appId)) throw new Error("Invalid app id");
  return appId;
}

function appPath(appId, filename = "") {
  return path.join(APP_DATA_ROOT, safeAppId(appId), filename);
}

function hostAppPath(appId) {
  return path.join(HOST_APP_DATA_ROOT, safeAppId(appId));
}

function parseYaml(text) {
  return YAML.parse(text) || {};
}

async function readYamlFile(filePath) {
  return parseYaml(await readFile(filePath, "utf8"));
}

function containerName(container) {
  return (container.Name || container.Names?.[0] || container.Id).replace(/^\//, "");
}

function projectFromContainer(container) {
  const labels = container.Config?.Labels || container.Labels || {};
  const project = labels["com.docker.compose.project"];
  if (project) return project;
  return containerName(container).split("_")[0];
}

function serviceFromContainer(container) {
  const labels = container.Config?.Labels || container.Labels || {};
  const service = labels["com.docker.compose.service"];
  if (service) return service;
  const name = containerName(container);
  return name.replace(/^.+?_/, "").replace(/[_-]?\d+$/, "");
}

function simplifyContainer(container) {
  return {
    id: container.Id,
    name: containerName(container),
    image: container.Image,
    state: container.State,
    status: container.Status,
    project: projectFromContainer(container),
    service: serviceFromContainer(container),
    ports: container.Ports || [],
  };
}

function normalizeEnvironment(environment) {
  if (!environment) return [];
  if (Array.isArray(environment)) {
    return environment.map((item) => {
      const [key, ...rest] = String(item).split("=");
      return { key, value: rest.join("=") };
    });
  }
  return Object.entries(environment).map(([key, value]) => ({ key, value: String(value ?? "") }));
}

function environmentToObject(variables) {
  const output = {};
  for (const item of variables || []) {
    const key = String(item.key || "").trim();
    if (!key) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable: ${key}`);
    output[key] = String(item.value ?? "");
  }
  return output;
}

function serviceImage(service) {
  return typeof service?.image === "string" ? service.image : "";
}

function getPrimaryServiceName(compose) {
  const services = Object.keys(compose.services || {});
  return (
    services.find((name) => !["app_proxy", "db", "database", "redis", "cache"].includes(name)) ||
    services.find((name) => name !== "app_proxy") ||
    services[0] ||
    ""
  );
}

async function listApps() {
  const [containers, entries] = await Promise.all([
    dockerRequest("GET", "/containers/json?all=1"),
    readdir(APP_DATA_ROOT, { withFileTypes: true }),
  ]);
  const simplified = containers.map(simplifyContainer);
  const apps = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const manifestPath = appPath(id, "umbrel-app.yml");
    const composePath = appPath(id, "docker-compose.yml");
    if (!existsSync(manifestPath) || !existsSync(composePath)) continue;

    let manifest = {};
    let compose = {};
    try {
      manifest = await readYamlFile(manifestPath);
      compose = await readYamlFile(composePath);
    } catch {
      continue;
    }

    const appContainers = simplified.filter((container) => container.project === id || container.name.startsWith(`${id}_`));
    const running = appContainers.filter((container) => container.state === "running").length;
    const primaryService = getPrimaryServiceName(compose);
    apps.push({
      id,
      name: manifest.name || id,
      tagline: manifest.tagline || "",
      icon: manifest.icon || "",
      category: manifest.category || "",
      version: manifest.version || "",
      primaryImage: serviceImage(compose.services?.[primaryService]),
      containers: appContainers.length,
      running,
      state: appContainers.length && running === appContainers.length ? "running" : running ? "partial" : "stopped",
    });
  }

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

async function getAppDetail(appId) {
  safeAppId(appId);
  const manifestPath = appPath(appId, "umbrel-app.yml");
  const composePath = appPath(appId, "docker-compose.yml");
  if (!existsSync(manifestPath) || !existsSync(composePath)) throw new Error("App not found");

  const [manifestText, composeText, containers] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(composePath, "utf8"),
    dockerRequest("GET", "/containers/json?all=1"),
  ]);
  const manifest = parseYaml(manifestText);
  const compose = parseYaml(composeText);
  const appContainers = containers
    .map(simplifyContainer)
    .filter((container) => container.project === appId || container.name.startsWith(`${appId}_`));

  const services = Object.entries(compose.services || {}).map(([name, service]) => {
    const related = appContainers.filter((container) => container.service === name || container.name.includes(`_${name}_`));
    return {
      name,
      image: serviceImage(service),
      isProxy: name === "app_proxy",
      environment: normalizeEnvironment(service.environment),
      ports: service.ports || [],
      volumes: service.volumes || [],
      restart: service.restart || "",
      containers: related,
    };
  });

  return {
    id: appId,
    name: manifest.name || appId,
    tagline: manifest.tagline || "",
    icon: manifest.icon || "",
    version: manifest.version || "",
    category: manifest.category || "",
    port: manifest.port || "",
    path: manifest.path || "",
    services,
    containers: appContainers,
    files: {
      compose: composeText,
      manifest: manifestText,
      settings: existsSync(appPath(appId, "settings.yml")) ? await readFile(appPath(appId, "settings.yml"), "utf8") : "",
    },
  };
}

async function inspectContainerEnv(containerId) {
  try {
    const detail = await dockerRequest("GET", `/containers/${encodeURIComponent(containerId)}/json`);
    return normalizeEnvironment(detail.Config?.Env || []).reduce((acc, item) => {
      acc[item.key] = item.value;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

async function buildComposeEnv(appId, compose, detail) {
  const env = {
    ...process.env,
    APP_DATA_DIR: hostAppPath(appId),
    DEVICE_DOMAIN_NAME: process.env.DEVICE_DOMAIN_NAME || "umbrel.local",
  };

  for (const service of detail.services) {
    const currentContainer = service.containers[0];
    if (!currentContainer) continue;
    const currentEnv = await inspectContainerEnv(currentContainer.id);
    for (const item of normalizeEnvironment(compose.services?.[service.name]?.environment)) {
      const exact = String(item.value || "").match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
      if (exact && currentEnv[item.key]) env[exact[1]] = currentEnv[item.key];
    }
  }

  return env;
}

async function saveServiceEnvironment(appId, serviceName, variables) {
  safeAppId(appId);
  if (!/^[a-zA-Z0-9_.-]+$/.test(serviceName)) throw new Error("Invalid service name");
  const composePath = appPath(appId, "docker-compose.yml");
  if (!existsSync(composePath)) throw new Error("docker-compose.yml not found");

  const original = await readFile(composePath, "utf8");
  const compose = parseYaml(original);
  const service = compose.services?.[serviceName];
  if (!service) throw new Error("Service not found");
  if (serviceName === "app_proxy") throw new Error("app_proxy is managed by Umbrel and is not editable here");

  service.environment = environmentToObject(variables);
  const backupDir = appPath(appId, ".container-studio-backups");
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `docker-compose.${stamp}.yml`);
  await writeFile(backupPath, original, "utf8");
  await writeFile(composePath, YAML.stringify(compose), "utf8");

  const detail = await getAppDetail(appId);
  const composeEnv = await buildComposeEnv(appId, compose, detail);
  await runCommand("docker", ["compose", "-f", composePath, "-p", appId, "up", "-d", "--force-recreate", serviceName], {
    env: composeEnv,
  });

  return { ok: true, backup: backupPath.replace(APP_DATA_ROOT, "") };
}

async function restartApp(appId) {
  const detail = await getAppDetail(appId);
  for (const container of detail.containers) {
    await dockerRequest("POST", `/containers/${encodeURIComponent(container.id)}/restart`);
  }
  return { ok: true };
}

async function getLogs(appId, serviceName = "") {
  const detail = await getAppDetail(appId);
  const candidates = serviceName
    ? detail.containers.filter((container) => container.service === serviceName)
    : detail.containers.filter((container) => container.service !== "app_proxy");
  const target = candidates[0] || detail.containers[0];
  if (!target) return { logs: "No hay contenedores para esta app." };
  const logs = await dockerRequest(
    "GET",
    `/containers/${encodeURIComponent(target.id)}/logs?stdout=1&stderr=1&tail=400&timestamps=1`,
  );
  return { logs: String(logs).replace(/\u0000/g, ""), container: target.name };
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/apps") {
    sendJson(res, 200, await listApps());
    return;
  }

  const match = url.pathname.match(/^\/api\/apps\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    sendJson(res, 404, { error: "API route not found" });
    return;
  }

  const appId = match[1];
  const action = match[2] || "detail";

  if (req.method === "GET" && action === "detail") {
    sendJson(res, 200, await getAppDetail(appId));
    return;
  }

  if (req.method === "GET" && action === "logs") {
    sendJson(res, 200, await getLogs(appId, url.searchParams.get("service") || ""));
    return;
  }

  if (req.method === "POST" && action === "restart") {
    sendJson(res, 200, await restartApp(appId));
    return;
  }

  if (req.method === "POST" && action === "env") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await saveServiceEnvironment(appId, body.service, body.variables));
    return;
  }

  sendJson(res, 404, { error: "Unsupported app action" });
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
