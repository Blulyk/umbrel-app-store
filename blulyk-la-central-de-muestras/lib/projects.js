import fs from "node:fs/promises";
import path from "node:path";

const SAFE_PROJECT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

export function assertSafeProjectName(name) {
  if (typeof name !== "string" || !SAFE_PROJECT_RE.test(name)) {
    throw new Error("Nombre de proyecto no valido");
  }
  return name;
}

export function projectUrl(publicBaseUrl) {
  if (!publicBaseUrl) return "";
  return `${publicBaseUrl.replace(/\/+$/, "")}/`;
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

function detectRuntime(packageJson) {
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  };
  if (dependencies.next) return "next";
  if (dependencies.vite || /(^|\s)vite(\s|$)/.test(packageJson.scripts?.dev || "")) return "vite";
  return packageJson.scripts?.dev ? "node" : "";
}

export class ProjectRegistry {
  constructor({ projectsDir, dataDir, publicBaseUrl = "" }) {
    this.projectsDir = projectsDir;
    this.dataDir = dataDir;
    this.publicBaseUrl = publicBaseUrl;
    this.statePath = path.join(dataDir, "state.json");
  }

  async readState() {
    const state = await readJson(this.statePath, { activeProject: "" });
    let activeProject = "";
    try {
      activeProject = state.activeProject ? assertSafeProjectName(state.activeProject) : "";
    } catch {
      activeProject = "";
    }
    return { activeProject };
  }

  async writeState(state) {
    await writeJson(this.statePath, { activeProject: state.activeProject ? assertSafeProjectName(state.activeProject) : "" });
  }

  async projectHasIndex(name) {
    try {
      const stat = await fs.stat(path.join(this.projectsDir, assertSafeProjectName(name), "index.html"));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async projectPackageInfo(name) {
    const packagePath = path.join(this.projectsDir, assertSafeProjectName(name), "package.json");
    const packageJson = await readJson(packagePath, null);
    if (!packageJson || typeof packageJson !== "object") {
      return { hasPackageJson: false, hasDevScript: false, runtime: "" };
    }

    const hasDevScript = typeof packageJson.scripts?.dev === "string" && packageJson.scripts.dev.trim().length > 0;
    return {
      hasPackageJson: true,
      hasDevScript,
      runtime: hasDevScript ? detectRuntime(packageJson) : ""
    };
  }

  async listProjects() {
    await fs.mkdir(this.projectsDir, { recursive: true });
    await fs.mkdir(this.dataDir, { recursive: true });
    const state = await this.readState();
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
      const packageInfo = await this.projectPackageInfo(name);
      const canPublish = hasIndex || packageInfo.hasDevScript;
      const mode = packageInfo.hasDevScript ? "dev" : hasIndex ? "static" : "";
      const enabled = canPublish && state.activeProject === name;
      return {
        name,
        hasIndex,
        ...packageInfo,
        canPublish,
        mode,
        enabled,
        publicUrl: enabled ? projectUrl(this.publicBaseUrl) : "",
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
    if (enabled && !project.canPublish) throw new Error("El proyecto necesita un index.html o un script dev");

    const current = await this.readState();
    const activeProject = enabled ? safeName : current.activeProject === safeName ? "" : current.activeProject;
    await this.writeState({ activeProject });

    return this.getProject(safeName);
  }

  async isEnabled(name) {
    const project = await this.getProject(name);
    return Boolean(project?.enabled);
  }

  async activeProject() {
    const state = await this.readState();
    return state.activeProject ? this.getProject(state.activeProject) : null;
  }
}
