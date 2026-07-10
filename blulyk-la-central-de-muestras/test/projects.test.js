import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectRegistry, assertSafeProjectName, publicProjectPath } from "../lib/projects.js";

async function makeRegistry() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muestras-projects-"));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "muestras-data-"));
  return {
    root,
    data,
    registry: new ProjectRegistry({
      projectsDir: root,
      dataDir: data,
      publicBaseUrl: "https://umbrel.tailcbdb4e.ts.net:10000"
    })
  };
}

test("assertSafeProjectName accepts simple website folder names", () => {
  assert.equal(assertSafeProjectName("web_fontanero"), "web_fontanero");
  assert.equal(assertSafeProjectName("cliente-2026"), "cliente-2026");
});

test("assertSafeProjectName rejects traversal and nested paths", () => {
  assert.throws(() => assertSafeProjectName("../secret"), /Nombre de proyecto no valido/);
  assert.throws(() => assertSafeProjectName("cliente/fase1"), /Nombre de proyecto no valido/);
  assert.throws(() => assertSafeProjectName(".hidden"), /Nombre de proyecto no valido/);
});

test("listProjects returns immediate folders and marks static and dev-ready websites", async () => {
  const { root, registry } = await makeRegistry();
  await fs.mkdir(path.join(root, "web_fontanero"), { recursive: true });
  await fs.writeFile(path.join(root, "web_fontanero", "index.html"), "<h1>Fontanero</h1>");
  await fs.mkdir(path.join(root, "react_cliente"), { recursive: true });
  await fs.writeFile(path.join(root, "react_cliente", "package.json"), JSON.stringify({
    scripts: { dev: "vite --host 0.0.0.0" },
    dependencies: { "@vitejs/plugin-react": "latest", vite: "latest" }
  }));
  await fs.mkdir(path.join(root, "notas"), { recursive: true });
  await fs.writeFile(path.join(root, "archivo.txt"), "ignored");

  const projects = await registry.listProjects();

  assert.deepEqual(projects.map((project) => project.name), ["notas", "react_cliente", "web_fontanero"]);
  assert.equal(projects.find((project) => project.name === "web_fontanero").hasIndex, true);
  assert.equal(projects.find((project) => project.name === "web_fontanero").mode, "static");
  assert.equal(projects.find((project) => project.name === "react_cliente").hasDevScript, true);
  assert.equal(projects.find((project) => project.name === "react_cliente").runtime, "vite");
  assert.equal(projects.find((project) => project.name === "react_cliente").mode, "dev");
  assert.equal(projects.find((project) => project.name === "notas").hasIndex, false);
});

test("setEnabled persists a single active project and public URL", async () => {
  const { root, registry } = await makeRegistry();
  await fs.mkdir(path.join(root, "web_fontanero"), { recursive: true });
  await fs.writeFile(path.join(root, "web_fontanero", "index.html"), "<h1>Fontanero</h1>");
  await fs.mkdir(path.join(root, "web_pintor"), { recursive: true });
  await fs.writeFile(path.join(root, "web_pintor", "index.html"), "<h1>Pintor</h1>");

  await registry.setEnabled("web_fontanero", true);
  let projects = await registry.listProjects();
  assert.equal(projects.find((project) => project.name === "web_fontanero").enabled, true);
  assert.equal(projects.find((project) => project.name === "web_fontanero").publicUrl, "https://umbrel.tailcbdb4e.ts.net:10000/");

  await registry.setEnabled("web_pintor", true);
  projects = await registry.listProjects();
  assert.equal(projects.find((project) => project.name === "web_fontanero").enabled, false);
  assert.equal(projects.find((project) => project.name === "web_pintor").enabled, true);

  const reloaded = new ProjectRegistry({
    projectsDir: root,
    dataDir: registry.dataDir,
    publicBaseUrl: "https://umbrel.tailcbdb4e.ts.net:10000"
  });
  projects = await reloaded.listProjects();
  assert.equal(projects.find((project) => project.name === "web_pintor").enabled, true);
});

test("setEnabled accepts dev projects without index.html", async () => {
  const { root, registry } = await makeRegistry();
  await fs.mkdir(path.join(root, "react_cliente"), { recursive: true });
  await fs.writeFile(path.join(root, "react_cliente", "package.json"), JSON.stringify({
    scripts: { dev: "vite --host 0.0.0.0" }
  }));

  const project = await registry.setEnabled("react_cliente", true);

  assert.equal(project.enabled, true);
  assert.equal(project.hasIndex, false);
  assert.equal(project.hasDevScript, true);
});

test("setEnabled refuses folders without index.html or a dev script", async () => {
  const { root, registry } = await makeRegistry();
  await fs.mkdir(path.join(root, "boceto"), { recursive: true });

  await assert.rejects(() => registry.setEnabled("boceto", true), /index.html o un script dev/);
});

test("publicProjectPath returns a normalized file path inside the project", async () => {
  const { root } = await makeRegistry();
  const file = publicProjectPath(root, "web_fontanero", "/assets/app.js");

  assert.equal(file, path.join(root, "web_fontanero", "assets", "app.js"));
  assert.throws(() => publicProjectPath(root, "web_fontanero", "/../secret.txt"), /Ruta no permitida/);
});
