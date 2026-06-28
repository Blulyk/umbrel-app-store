import fs from "node:fs/promises";
import path from "node:path";

const SAFE_PROJECT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

export function assertSafeProjectName(name) {
  if (typeof name !== "string" || !SAFE_PROJECT_RE.test(name)) {
    throw new Error("Nombre de proyecto no valido");
  }
  return name;
}

export function projectUrl(publicBaseUrl, name) {
  if (!publicBaseUrl) return "";
  return `${publicBaseUrl.replace(/\/+$/, "")}/_muestras/${encodeURIComponent(name)}/`;
}

export function publicProjectPath(projectsDir, name, requestPath = "/") {
  const safeName = assertSafeProjectName(name);
  const cleanRequestPath = decodeURIComponent(String(requestPath || "/")).replace(/^\/+/, "");
  const projectRoot = path.resolve(projectsDir, safeName);
  const filePath = path.resolve(projectRoot, cleanRequestPath || "index.html");

  if (filePath !== projectRoot && !filePath.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("Ruta no permitida");
  }

  return filePath;
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

export class ProjectRegistry {
  constructor({ projectsDir, dataDir, publicBaseUrl = "" }) {
    this.projectsDir = projectsDir;
    this.dataDir = dataDir;
    this.publicBaseUrl = publicBaseUrl;
    this.statePath = path.join(dataDir, "state.json");
  }

  async readState() {
    const state = await readJson(this.statePath, { enabled: [] });
    return {
      enabled: Array.isArray(state.enabled)
        ? state.enabled.filter((name) => {
            try {
              assertSafeProjectName(name);
              return true;
            } catch {
              return false;
            }
          })
        : []
    };
  }

  async writeState(state) {
    const enabled = [...new Set(state.enabled.map(assertSafeProjectName))].sort();
    await writeJson(this.statePath, { enabled });
  }

  async projectHasIndex(name) {
    try {
      const stat = await fs.stat(path.join(this.projectsDir, assertSafeProjectName(name), "index.html"));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async listProjects() {
    await fs.mkdir(this.projectsDir, { recursive: true });
    await fs.mkdir(this.dataDir, { recursive: true });
    const state = await this.readState();
    const enabledSet = new Set(state.enabled);
    const entries = await fs.readdir(this.projectsDir, { withFileTypes: true });
    const folders = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          assertSafeProjectName(name);
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));

    return Promise.all(folders.map(async (name) => {
      const hasIndex = await this.projectHasIndex(name);
      const enabled = hasIndex && enabledSet.has(name);
      return {
        name,
        hasIndex,
        enabled,
        publicUrl: enabled ? projectUrl(this.publicBaseUrl, name) : "",
        path: path.join(this.projectsDir, name)
      };
    }));
  }

  async getProject(name) {
    const safeName = assertSafeProjectName(name);
    const projects = await this.listProjects();
    return projects.find((project) => project.name === safeName) || null;
  }

  async setEnabled(name, enabled) {
    const safeName = assertSafeProjectName(name);
    const project = await this.getProject(safeName);
    if (!project) throw new Error("Proyecto no encontrado");
    if (enabled && !project.hasIndex) throw new Error("El proyecto necesita un index.html");

    const state = await this.readState();
    const enabledSet = new Set(state.enabled);
    if (enabled) enabledSet.add(safeName);
    else enabledSet.delete(safeName);
    await this.writeState({ enabled: [...enabledSet] });

    return this.getProject(safeName);
  }

  async isEnabled(name) {
    const project = await this.getProject(name);
    return Boolean(project?.enabled);
  }
}
