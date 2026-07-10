import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../server.js";

async function withServer(options = {}) {
  const projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "muestras-http-projects-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "muestras-http-data-"));
  const app = createApp({
    projectsDir,
    dataDir,
    publicBaseUrl: "https://umbrel.tailcbdb4e.ts.net:10000",
    ...options
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    projectsDir,
    dataDir,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { "content-type": "application/json" },
    ...options
  });
  return { response, body: await response.json() };
}

test("GET /api/projects lists project folders", async () => {
  const ctx = await withServer();
  try {
    await fs.mkdir(path.join(ctx.projectsDir, "web_fontanero"));
    await fs.writeFile(path.join(ctx.projectsDir, "web_fontanero", "index.html"), "<h1>Hola</h1>");

    const { response, body } = await requestJson(ctx.baseUrl, "/api/projects");

    assert.equal(response.status, 200);
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].name, "web_fontanero");
    assert.equal(body.projects[0].enabled, false);
  } finally {
    await ctx.close();
  }
});

test("POST /api/projects/:name/enable creates a public URL", async () => {
  const ctx = await withServer();
  try {
    await fs.mkdir(path.join(ctx.projectsDir, "web_fontanero"));
    await fs.writeFile(path.join(ctx.projectsDir, "web_fontanero", "index.html"), "<h1>Hola</h1>");

    const { response, body } = await requestJson(ctx.baseUrl, "/api/projects/web_fontanero/enable", { method: "POST" });

    assert.equal(response.status, 200);
    assert.equal(body.project.enabled, true);
    assert.equal(body.project.publicUrl, "https://umbrel.tailcbdb4e.ts.net:10000/");
  } finally {
    await ctx.close();
  }
});

test("GET /_muestras/:project serves only enabled projects", async () => {
  const ctx = await withServer();
  try {
    await fs.mkdir(path.join(ctx.projectsDir, "web_fontanero"));
    await fs.writeFile(path.join(ctx.projectsDir, "web_fontanero", "index.html"), "<h1>Hola cliente</h1>");

    let response = await fetch(`${ctx.baseUrl}/_muestras/web_fontanero/`);
    assert.equal(response.status, 404);

    await requestJson(ctx.baseUrl, "/api/projects/web_fontanero/enable", { method: "POST" });
    response = await fetch(`${ctx.baseUrl}/_muestras/web_fontanero/`);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /Hola cliente/);
  } finally {
    await ctx.close();
  }
});

test("GET /_active serves the active project at the root", async () => {
  const ctx = await withServer();
  try {
    await fs.mkdir(path.join(ctx.projectsDir, "web_fontanero"));
    await fs.writeFile(path.join(ctx.projectsDir, "web_fontanero", "index.html"), "<h1>Hola activo</h1>");

    let response = await fetch(`${ctx.baseUrl}/_active/`);
    assert.equal(response.status, 404);

    await requestJson(ctx.baseUrl, "/api/projects/web_fontanero/enable", { method: "POST" });
    response = await fetch(`${ctx.baseUrl}/_active/`);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /Hola activo/);
  } finally {
    await ctx.close();
  }
});

test("GET /_active falls back to index.html for SPA routes without file extensions", async () => {
  const ctx = await withServer();
  try {
    await fs.mkdir(path.join(ctx.projectsDir, "react_demo", "assets"), { recursive: true });
    await fs.writeFile(path.join(ctx.projectsDir, "react_demo", "index.html"), "<h1>SPA Shell</h1>");
    await fs.writeFile(path.join(ctx.projectsDir, "react_demo", "assets", "app.js"), "console.log('asset');");

    await requestJson(ctx.baseUrl, "/api/projects/react_demo/enable", { method: "POST" });
    const response = await fetch(`${ctx.baseUrl}/_active/clientes/raquel`);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /SPA Shell/);
  } finally {
    await ctx.close();
  }
});

test("GET /_active serves real assets and keeps missing asset paths as 404", async () => {
  const ctx = await withServer();
  try {
    await fs.mkdir(path.join(ctx.projectsDir, "react_demo", "assets"), { recursive: true });
    await fs.writeFile(path.join(ctx.projectsDir, "react_demo", "index.html"), "<h1>SPA Shell</h1>");
    await fs.writeFile(path.join(ctx.projectsDir, "react_demo", "assets", "app.js"), "console.log('asset');");

    await requestJson(ctx.baseUrl, "/api/projects/react_demo/enable", { method: "POST" });
    let response = await fetch(`${ctx.baseUrl}/_active/assets/app.js`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /asset/);

    response = await fetch(`${ctx.baseUrl}/_active/assets/missing.js`);
    assert.equal(response.status, 404);
  } finally {
    await ctx.close();
  }
});

test("POST /api/projects/:name/disable removes public access", async () => {
  const ctx = await withServer();
  try {
    await fs.mkdir(path.join(ctx.projectsDir, "web_fontanero"));
    await fs.writeFile(path.join(ctx.projectsDir, "web_fontanero", "index.html"), "<h1>Hola</h1>");

    await requestJson(ctx.baseUrl, "/api/projects/web_fontanero/enable", { method: "POST" });
    const { response, body } = await requestJson(ctx.baseUrl, "/api/projects/web_fontanero/disable", { method: "POST" });

    assert.equal(response.status, 200);
    assert.equal(body.project.enabled, false);
    const publicResponse = await fetch(`${ctx.baseUrl}/_muestras/web_fontanero/`);
    assert.equal(publicResponse.status, 404);
  } finally {
    await ctx.close();
  }
});

test("GET /_active proxies dev projects without index.html", async () => {
  const target = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<h1>Dev server ${req.url}</h1>`);
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const { port } = target.address();
  const devServerManager = {
    ensureRunning: async (project) => ({
      target: `http://127.0.0.1:${port}`,
      port,
      status: "running",
      project: project.name
    }),
    stop: async () => {}
  };
  const ctx = await withServer({ devServerManager });
  try {
    await fs.mkdir(path.join(ctx.projectsDir, "react_cliente"));
    await fs.writeFile(path.join(ctx.projectsDir, "react_cliente", "package.json"), JSON.stringify({
      scripts: { dev: "vite --host 0.0.0.0" }
    }));

    await requestJson(ctx.baseUrl, "/api/projects/react_cliente/enable", { method: "POST" });
    const response = await fetch(`${ctx.baseUrl}/_active/clientes/raquel`);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /Dev server \/clientes\/raquel/);
  } finally {
    await ctx.close();
    await new Promise((resolve) => target.close(resolve));
  }
});

test("GET /_active prefers dev server for Vite projects that also have index.html", async () => {
  const target = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end(`console.log("dev ${req.url}")`);
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const { port } = target.address();
  const devServerManager = {
    ensureRunning: async (project) => ({
      target: `http://127.0.0.1:${port}`,
      port,
      status: "running",
      project: project.name
    }),
    stop: async () => {}
  };
  const ctx = await withServer({ devServerManager });
  try {
    await fs.mkdir(path.join(ctx.projectsDir, "vite_cliente", "src"), { recursive: true });
    await fs.writeFile(path.join(ctx.projectsDir, "vite_cliente", "index.html"), "<h1>Static fallback would be wrong</h1>");
    await fs.writeFile(path.join(ctx.projectsDir, "vite_cliente", "package.json"), JSON.stringify({
      scripts: { dev: "vite" },
      dependencies: { vite: "latest" }
    }));

    await requestJson(ctx.baseUrl, "/api/projects/vite_cliente/enable", { method: "POST" });
    const response = await fetch(`${ctx.baseUrl}/_active/src/main.jsx`);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /dev \/src\/main.jsx/);
  } finally {
    await ctx.close();
    await new Promise((resolve) => target.close(resolve));
  }
});
