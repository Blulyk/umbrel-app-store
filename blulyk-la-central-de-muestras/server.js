import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";

import { ProjectRegistry, assertSafeProjectName, publicProjectPath } from "./lib/projects.js";
import { FunnelManager } from "./lib/funnel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function wantsIndex(requestPath) {
  return !requestPath || requestPath === "/" || requestPath.endsWith("/");
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
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

export function createApp({
  projectsDir = process.env.PROJECTS_DIR || "/projects",
  hostProjectsDir = process.env.HOST_PROJECTS_DIR || "/home/umbrel/umbrel/home/proyectos",
  dataDir = process.env.DATA_DIR || "/data",
  publicBaseUrl = process.env.PUBLIC_BASE_URL || "",
  tailnetDomain = process.env.TAILNET_DOMAIN || "tailcbdb4e.ts.net",
  docker = process.env.DOCKER_DISABLED === "1" ? null : new Docker({ socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock" }),
  funnelManager = null,
  initialConfig = null
} = {}) {
  const app = express();
  const configPath = path.join(dataDir, "config.json");
  const loadConfig = async () => ({
    tailnetDomain,
    authKey: process.env.TAILSCALE_AUTHKEY || "",
    ...(initialConfig || {}),
    ...(await readJson(configPath, {}))
  });
  const saveConfig = async (config) => writeJson(configPath, {
    tailnetDomain: String(config.tailnetDomain || tailnetDomain).trim(),
    authKey: String(config.authKey || "").trim()
  });
  const makeRegistry = async () => {
    const config = await loadConfig();
    return new ProjectRegistry({ projectsDir, dataDir, publicBaseUrl, tailnetDomain: config.tailnetDomain });
  };

  app.use(express.json({ limit: "256kb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/health", asyncRoute(async (_req, res) => {
    const registry = await makeRegistry();
    const config = await loadConfig();
    const projects = await registry.listProjects();
    res.json({
      ok: true,
      projectsDir,
      hostProjectsDir,
      dataDir,
      tailnetDomain: config.tailnetDomain,
      configured: Boolean(config.authKey && config.tailnetDomain),
      projects: projects.length
    });
  }));

  app.get("/api/config", asyncRoute(async (_req, res) => {
    const config = await loadConfig();
    res.json({
      tailnetDomain: config.tailnetDomain,
      hasAuthKey: Boolean(config.authKey)
    });
  }));

  app.put("/api/config", asyncRoute(async (req, res) => {
    await saveConfig(req.body || {});
    const config = await loadConfig();
    res.json({
      tailnetDomain: config.tailnetDomain,
      hasAuthKey: Boolean(config.authKey)
    });
  }));

  app.get("/api/projects", asyncRoute(async (_req, res) => {
    const registry = await makeRegistry();
    const config = await loadConfig();
    res.json({
      tailnetDomain: config.tailnetDomain,
      hasAuthKey: Boolean(config.authKey),
      projectsDir,
      projects: await registry.listProjects()
    });
  }));

  app.post("/api/projects/:name/enable", asyncRoute(async (req, res) => {
    const registry = await makeRegistry();
    const config = await loadConfig();
    const project = await registry.getProject(req.params.name);
    if (!project) return res.status(404).json({ error: "Proyecto no encontrado" });
    if (!project.hasIndex) return res.status(400).json({ error: "El proyecto necesita un index.html" });
    const manager = funnelManager || new FunnelManager({
      docker,
      dataDir,
      hostProjectsDir,
      tailnetDomain: config.tailnetDomain,
      authKey: config.authKey
    });
    await manager.publish(project);
    res.json({ project: await registry.setEnabled(req.params.name, true) });
  }));

  app.post("/api/projects/:name/disable", asyncRoute(async (req, res) => {
    const registry = await makeRegistry();
    const config = await loadConfig();
    const manager = funnelManager || new FunnelManager({
      docker,
      dataDir,
      hostProjectsDir,
      tailnetDomain: config.tailnetDomain,
      authKey: config.authKey
    });
    await manager.unpublish(req.params.name);
    const project = await registry.setEnabled(req.params.name, false);
    res.json({ project });
  }));

  app.get("/_muestras/:name/*?", asyncRoute(async (req, res) => {
    const registry = await makeRegistry();
    const name = assertSafeProjectName(req.params.name);
    if (!(await registry.isEnabled(name))) {
      return res.status(404).type("text/plain").send("Muestra no publicada");
    }

    const suffix = req.params[0] || "/";
    const staticPath = wantsIndex(suffix) ? `${suffix.replace(/\/+$/, "")}/index.html` : suffix;
    const filePath = publicProjectPath(projectsDir, name, staticPath);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) return res.status(404).type("text/plain").send("Archivo no encontrado");
    return res.sendFile(filePath);
  }));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.use((err, _req, res, _next) => {
    const status = /no encontrado/i.test(err.message) ? 404 : /no valido|no permitida|index\.html|auth key|tailnet|docker/i.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message || "Error interno" });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`La central de muestras listening on ${port}`);
  });
}
