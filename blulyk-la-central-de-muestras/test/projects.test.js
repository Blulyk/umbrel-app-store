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
      tailnetDomain: "tailcbdb4e.ts.net"
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

test("listProjects returns immediate folders and marks websites with index.html", async () => {
  const { root, registry } = await makeRegistry();
  await fs.mkdir(path.join(root, "web_fontanero"), { recursive: true });
  await fs.writeFile(path.join(root, "web_fontanero", "index.html"), "<h1>Fontanero</h1>");
  await fs.mkdir(path.join(root, "notas"), { recursive: true });
  await fs.writeFile(path.join(root, "archivo.txt"), "ignored");

  const projects = await registry.listProjects();

  assert.deepEqual(projects.map((project) => project.name), ["notas", "web_fontanero"]);
  assert.equal(projects.find((project) => project.name === "web_fontanero").hasIndex, true);
  assert.equal(projects.find((project) => project.name === "notas").hasIndex, false);
});

test("setEnabled persists enabled project state and public URL", async () => {
  const { root, registry } = await makeRegistry();
  await fs.mkdir(path.join(root, "web_fontanero"), { recursive: true });
  await fs.writeFile(path.join(root, "web_fontanero", "index.html"), "<h1>Fontanero</h1>");

  await registry.setEnabled("web_fontanero", true);
  let projects = await registry.listProjects();
  assert.equal(projects[0].enabled, true);
  assert.equal(projects[0].publicUrl, "https://muestra-web-fontanero.tailcbdb4e.ts.net/");

  const reloaded = new ProjectRegistry({
    projectsDir: root,
    dataDir: registry.dataDir,
    tailnetDomain: "tailcbdb4e.ts.net"
  });
  projects = await reloaded.listProjects();
  assert.equal(projects[0].enabled, true);
});

test("setEnabled refuses folders without index.html", async () => {
  const { root, registry } = await makeRegistry();
  await fs.mkdir(path.join(root, "boceto"), { recursive: true });

  await assert.rejects(() => registry.setEnabled("boceto", true), /index.html/);
});

test("publicProjectPath returns a normalized file path inside the project", async () => {
  const { root } = await makeRegistry();
  const file = publicProjectPath(root, "web_fontanero", "/assets/app.js");

  assert.equal(file, path.join(root, "web_fontanero", "assets", "app.js"));
  assert.throws(() => publicProjectPath(root, "web_fontanero", "/../secret.txt"), /Ruta no permitida/);
});
