const state = {
  servers: [],
  currentId: null,
  activeTab: "control"
};

const $ = (selector) => document.querySelector(selector);
const form = $("#serverForm");

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const text = await res.text();
  const data = text && res.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text;
  if (!res.ok) throw new Error(data?.error || data || `HTTP ${res.status}`);
  return data;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.classList.remove("show"), 3200);
}

function fmtBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value > 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function currentServer() {
  return state.servers.find((server) => server.id === state.currentId);
}

async function loadHealth() {
  try {
    const health = await api("/api/health");
    $("#health").textContent = health.steamcmd ? "SteamCMD listo" : "SteamCMD no encontrado";
  } catch {
    $("#health").textContent = "Sin conexion";
  }
}

async function loadServers() {
  state.servers = await api("/api/servers");
  if (!state.currentId && state.servers[0]) state.currentId = state.servers[0].id;
  if (state.currentId && !state.servers.some((server) => server.id === state.currentId)) {
    state.currentId = state.servers[0]?.id || null;
  }
  render();
}

function renderServerList() {
  const list = $("#serverList");
  list.innerHTML = "";
  for (const server of state.servers) {
    const item = document.createElement("button");
    item.className = `server-item ${server.id === state.currentId ? "active" : ""}`;
    item.innerHTML = `<strong>${server.name}</strong><span>${server.runtime.state} · ${server.gamePort}/${server.queryPort}</span>`;
    item.onclick = () => {
      state.currentId = server.id;
      render();
      loadLogs();
      loadBackups();
    };
    list.append(item);
  }
}

function renderDetails() {
  const server = currentServer();
  $("#title").textContent = server?.name || "Selecciona un servidor";
  $("#state").textContent = server?.runtime.state || "-";
  $("#players").textContent = server ? `${server.maxPlayers}` : "-";
  $("#ports").textContent = server ? `${server.gamePort}/${server.queryPort}` : "-";

  for (const element of document.querySelectorAll("button, input, textarea")) {
    if (element.id === "newServer") continue;
    element.disabled = !server;
  }

  if (!server) {
    form.reset();
    $("#logOutput").textContent = "";
    $("#backupList").innerHTML = "";
    return;
  }

  form.name.value = server.name;
  form.description.value = server.description || "";
  form.maxPlayers.value = server.maxPlayers;
  form.gamePort.value = server.gamePort;
  form.queryPort.value = server.queryPort;
  form.password.value = server.password || "";
  form.branch.value = server.branch || "public";
  form.executablePath.value = server.executablePath || "";
  form.launchArgs.value = server.launchArgs || "";
  form.configText.value = server.configText || "";

  $("#startBtn").disabled = server.runtime.state !== "stopped";
  $("#stopBtn").disabled = server.runtime.state !== "running";
}

async function renderJobs() {
  const jobs = await api("/api/jobs");
  const node = $("#jobs");
  node.innerHTML = "";
  if (!jobs.length) {
    node.innerHTML = `<div class="job"><span>No hay tareas recientes</span></div>`;
    return;
  }
  for (const job of jobs) {
    const item = document.createElement("div");
    item.className = "job";
    item.innerHTML = `<div><strong>${job.type}</strong><br>${job.serverName}</div><span>${job.done ? `finalizada (${job.exitCode})` : "en marcha"}</span>`;
    node.append(item);
  }
}

function renderTabs() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === state.activeTab);
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === state.activeTab);
  }
}

function render() {
  renderServerList();
  renderDetails();
  renderTabs();
  renderJobs().catch(() => {});
}

async function createServer() {
  const portBase = 27015 + state.servers.length * 2;
  const server = await api("/api/servers", {
    method: "POST",
    body: JSON.stringify({
      name: `Base Nautilus ${state.servers.length + 1}`,
      maxPlayers: 4,
      gamePort: portBase,
      queryPort: portBase + 1
    })
  });
  state.currentId = server.id;
  await loadServers();
  toast("Servidor creado");
}

function formPayload() {
  return {
    name: form.name.value.trim(),
    description: form.description.value.trim(),
    maxPlayers: Number(form.maxPlayers.value),
    gamePort: Number(form.gamePort.value),
    queryPort: Number(form.queryPort.value),
    password: form.password.value,
    branch: form.branch.value.trim() || "public",
    executablePath: form.executablePath.value.trim(),
    launchArgs: form.launchArgs.value.trim(),
    configText: form.configText.value
  };
}

async function saveServer(event) {
  event.preventDefault();
  const server = currentServer();
  if (!server) return;
  await api(`/api/servers/${server.id}`, {
    method: "PUT",
    body: JSON.stringify(formPayload())
  });
  await loadServers();
  toast("Configuracion guardada");
}

async function action(path, message) {
  const server = currentServer();
  if (!server) return;
  await api(`/api/servers/${server.id}/${path}`, { method: "POST" });
  await loadServers();
  await loadLogs();
  toast(message);
}

async function loadLogs() {
  const server = currentServer();
  if (!server) return;
  const logs = await api(`/api/servers/${server.id}/logs?max=90000`, {
    headers: { "Content-Type": "text/plain" }
  });
  $("#logOutput").textContent = logs || "Sin logs todavia.";
  $("#logOutput").scrollTop = $("#logOutput").scrollHeight;
}

async function loadBackups() {
  const server = currentServer();
  if (!server) return;
  const backups = await api(`/api/servers/${server.id}/backups`);
  const list = $("#backupList");
  list.innerHTML = "";
  if (!backups.length) {
    list.innerHTML = `<div class="backup-item"><span>No hay backups para este servidor</span></div>`;
    return;
  }
  for (const backup of backups) {
    const item = document.createElement("div");
    item.className = "backup-item";
    item.innerHTML = `<div><strong>${backup.name}</strong><br>${new Date(backup.createdAt).toLocaleString()}</div><span>${fmtBytes(backup.size)}</span>`;
    list.append(item);
  }
}

async function deleteServer() {
  const server = currentServer();
  if (!server) return;
  if (!confirm(`Borrar ${server.name} y sus datos locales?`)) return;
  await api(`/api/servers/${server.id}`, { method: "DELETE" });
  state.currentId = null;
  await loadServers();
  toast("Servidor borrado");
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    state.activeTab = tab.dataset.tab;
    renderTabs();
    if (state.activeTab === "logs") loadLogs().catch((error) => toast(error.message));
    if (state.activeTab === "backups") loadBackups().catch((error) => toast(error.message));
  };
}

$("#newServer").onclick = () => createServer().catch((error) => toast(error.message));
$("#installBtn").onclick = () => action("install", "Instalacion/actualizacion iniciada").catch((error) => toast(error.message));
$("#startBtn").onclick = () => action("start", "Servidor arrancando").catch((error) => toast(error.message));
$("#stopBtn").onclick = () => action("stop", "Parada solicitada").catch((error) => toast(error.message));
$("#refreshLogs").onclick = () => loadLogs().catch((error) => toast(error.message));
$("#backupBtn").onclick = () => action("backups", "Backup en marcha").then(loadBackups).catch((error) => toast(error.message));
$("#refreshBackups").onclick = () => loadBackups().catch((error) => toast(error.message));
$("#deleteBtn").onclick = () => deleteServer().catch((error) => toast(error.message));
form.onsubmit = saveServer;

setInterval(() => {
  loadServers().catch(() => {});
  if (state.activeTab === "logs") loadLogs().catch(() => {});
}, 5000);

await loadHealth();
await loadServers();
if (!state.servers.length) await createServer();
