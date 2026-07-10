import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { assertSafeProjectName } from "./projects.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function devArgs(runtime, port) {
  if (runtime === "next") return ["--hostname", "0.0.0.0", "--port", String(port)];
  if (runtime === "vite") return ["--host", "0.0.0.0", "--port", String(port)];
  return [];
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve(output);
      reject(new Error(output.trim() || `${command} salio con codigo ${code}`));
    });
  });
}

export class DevServerManager {
  constructor({ projectsDir, portStart = 4300, portEnd = 4399, installTimeoutMs = 180000, startupTimeoutMs = 90000 } = {}) {
    this.projectsDir = projectsDir;
    this.portStart = portStart;
    this.portEnd = portEnd;
    this.installTimeoutMs = installTimeoutMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.servers = new Map();
    this.nextPort = portStart;
  }

  allocatePort() {
    const port = this.nextPort;
    this.nextPort += 1;
    if (this.nextPort > this.portEnd) this.nextPort = this.portStart;
    return port;
  }

  projectRoot(projectName) {
    return path.join(this.projectsDir, assertSafeProjectName(projectName));
  }

  async ensureDependencies(projectRoot) {
    const nodeModules = path.join(projectRoot, "node_modules");
    const existing = await fs.stat(nodeModules).catch(() => null);
    if (existing?.isDirectory()) return;

    if (await commandExists("npm")) {
      await run("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: projectRoot,
        timeout: this.installTimeoutMs,
        env: { ...process.env, npm_config_update_notifier: "false" }
      });
      return;
    }

    throw new Error("No se encontro npm dentro del contenedor");
  }

  async waitUntilReady(target, record) {
    const started = Date.now();
    while (Date.now() - started < this.startupTimeoutMs) {
      if (record.process.exitCode !== null) break;
      try {
        const response = await fetch(target, { redirect: "manual" });
        if (response.status < 500) return;
      } catch {
        await delay(1000);
      }
    }

    const tail = record.logs.slice(-20).join("").trim();
    throw new Error(`El servidor dev no arranco a tiempo${tail ? `: ${tail}` : ""}`);
  }

  async ensureRunning(project) {
    const safeName = assertSafeProjectName(project.name);
    const current = this.servers.get(safeName);
    if (current?.process?.exitCode === null) return current;

    const projectRoot = this.projectRoot(safeName);
    await this.ensureDependencies(projectRoot);

    const port = current?.port || this.allocatePort();
    const args = ["run", "dev", "--", ...devArgs(project.runtime, port)];
    const env = {
      ...process.env,
      HOST: "0.0.0.0",
      HOSTNAME: "0.0.0.0",
      PORT: String(port),
      CHOKIDAR_USEPOLLING: "true",
      WATCHPACK_POLLING: "true",
      npm_config_update_notifier: "false"
    };
    const child = spawn("npm", args, { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    const record = {
      project: safeName,
      port,
      target: `http://127.0.0.1:${port}`,
      status: "starting",
      process: child,
      logs: []
    };

    const collect = (chunk) => {
      record.logs.push(chunk.toString());
      if (record.logs.length > 80) record.logs.shift();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("exit", () => {
      if (this.servers.get(safeName) === record) record.status = "stopped";
    });
    this.servers.set(safeName, record);

    await this.waitUntilReady(record.target, record);
    record.status = "running";
    return record;
  }

  async stop(projectName) {
    const safeName = assertSafeProjectName(projectName);
    const current = this.servers.get(safeName);
    if (!current) return;
    this.servers.delete(safeName);
    if (current.process.exitCode === null) current.process.kill("SIGTERM");
  }
}
