import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProjectRegistry, assertSafeProjectName, publicProjectPath } from "./lib/projects.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function wantsIndex(requestPath) {
  return !requestPath || requestPath === "/" || requestPath.endsWith("/");
}

function hasFileExtension(requestPath) {
  return Boolean(path.extname(String(requestPath || "").split("?")[0]));
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function resolveProjectFile(projectsDir, projectName, suffix) {
  const staticPath = wantsIndex(suffix) ? `${suffix.replace(/\/+$/, "")}/index.html` : suffix;
  const filePath = publicProjectPath(projectsDir, projectName, staticPath);
  const stat = await fs.stat(filePath).catch(() => null);
  if (stat?.isFile()) return filePath;
  if (hasFileExtension(suffix)) return "";

  const indexPath = publicProjectPath(projectsDir, projectName, "index.html");
  const indexStat = await fs.stat(indexPath).catch(() => null);
  return indexStat?.isFile() ? indexPath : "";
}

export function createApp({
  projectsDir = process.env.PROJECTS_DIR || "/projects",
  dataDir = process.env.DATA_DIR || "/data",
  publicBaseUrl = process.env.PUBLIC_BASE_URL || "https://umbrel.tailcbdb4e.ts.net:10000"
} = {}) {
  const app = express();
  const makeRegistry = () => new ProjectRegistry({ projectsDir, dataDir, publicBaseUrl });

  app.use(express.json({ limit: "256kb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/health", asyncRoute(async (_req, res) => {
    const registry = makeRegistry();
    const projects = await registry.listProjects();
    res.json({
      ok: true,
      projectsDir,
      dataDir,
      publicBaseUrl,
      projects: projects.length
    });
  }));

  app.get("/api/config", asyncRoute(async (_req, res) => {
    res.json({
      publicBaseUrl
    });
  }));

  app.get("/api/projects", asyncRoute(async (_req, res) => {
    const registry = makeRegistry();
    res.json({
      publicBaseUrl,
      projectsDir,
      projects: await registry.listProjects()
    });
  }));

  app.post("/api/projects/:name/enable", asyncRoute(async (req, res) => {
    const registry = makeRegistry();
    const project = await registry.getProject(req.params.name);
    if (!project) return res.status(404).json({ error: "Proyecto no encontrado" });
    if (!project.hasIndex) return res.status(400).json({ error: "El proyecto necesita un index.html" });
    res.json({ project: await registry.setEnabled(req.params.name, true) });
  }));

  app.post("/api/projects/:name/disable", asyncRoute(async (req, res) => {
    const registry = makeRegistry();
    const project = await registry.setEnabled(req.params.name, false);
    res.json({ project });
  }));

  app.get("/_active/*?", asyncRoute(async (req, res) => {
    const registry = makeRegistry();
    const project = await registry.activeProject();
    if (!project?.enabled) return res.status(404).type("text/plain").send("No hay ninguna muestra publicada");

    const suffix = req.params[0] || "/";
    const filePath = await resolveProjectFile(projectsDir, project.name, suffix);
    if (!filePath) return res.status(404).type("text/plain").send("Archivo no encontrado");
    return res.sendFile(filePath);
  }));

  app.get("/_muestras/:name/*?", asyncRoute(async (req, res) => {
    const registry = makeRegistry();
    const name = assertSafeProjectName(req.params.name);
    if (!(await registry.isEnabled(name))) {
      return res.status(404).type("text/plain").send("Muestra no publicada");
    }

    const suffix = req.params[0] || "/";
    const filePath = await resolveProjectFile(projectsDir, name, suffix);
    if (!filePath) return res.status(404).type("text/plain").send("Archivo no encontrado");
    return res.sendFile(filePath);
  }));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.use((err, _req, res, _next) => {
    const status = /no encontrado/i.test(err.message) ? 404 : /no valido|no permitida|index\.html/i.test(err.message) ? 400 : 500;
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
