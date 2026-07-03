const state = {
  containers: [],
  selectedId: null,
  detail: null,
  logs: "",
};

const els = {
  list: document.querySelector("#containerList"),
  search: document.querySelector("#search"),
  refresh: document.querySelector("#refresh"),
  title: document.querySelector("#containerTitle"),
  detail: document.querySelector("#detail"),
  empty: document.querySelector("#emptyState"),
  start: document.querySelector("#startBtn"),
  stop: document.querySelector("#stopBtn"),
  restart: document.querySelector("#restartBtn"),
  toast: document.querySelector("#toast"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Error inesperado");
  return data;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.add("hidden"), 3600);
}

function stateClass(container) {
  return container.state === "running" ? "running" : container.state === "exited" ? "exited" : "";
}

function renderList() {
  const query = els.search.value.trim().toLowerCase();
  const containers = state.containers.filter((container) => {
    const haystack = `${container.name} ${container.image} ${container.project}`.toLowerCase();
    return haystack.includes(query);
  });

  els.list.innerHTML = containers
    .map(
      (container) => `
        <button class="container-card ${container.id === state.selectedId ? "active" : ""}" data-id="${container.id}">
          <div class="row">
            <span class="name">${escapeHtml(container.name)}</span>
            <span class="chip ${stateClass(container)}">${escapeHtml(container.state)}</span>
          </div>
          <div class="meta">${escapeHtml(container.image)}</div>
          <div class="row">
            <span class="meta">${escapeHtml(container.project || "sin proyecto")}</span>
            <span class="meta">${escapeHtml(container.status || "")}</span>
          </div>
        </button>
      `,
    )
    .join("");
}

function renderField(label, value) {
  return `
    <div class="field">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value || "-")}</div>
    </div>
  `;
}

function renderOverview(detail) {
  document.querySelector("#overview").innerHTML = `
    <div class="grid">
      ${renderField("Imagen de Docker", detail.image)}
      ${renderField("Proyecto Compose", detail.project)}
      ${renderField("Estado", `${detail.state?.Status || "-"} ${detail.state?.Running ? "(running)" : ""}`)}
      ${renderField("Política de reinicio", detail.restartPolicy?.Name || "sin política")}
      ${renderField("Red", detail.networkMode)}
      ${renderField("Creado", new Date(detail.created).toLocaleString())}
      ${renderField("Entrypoint", Array.isArray(detail.entrypoint) ? detail.entrypoint.join(" ") : detail.entrypoint)}
      ${renderField("Comando", Array.isArray(detail.command) ? detail.command.join(" ") : detail.command)}
    </div>
  `;
}

function renderPorts(detail) {
  const rows = Object.entries(detail.ports || {})
    .map(([containerPort, bindings]) => {
      const publicValue = bindings?.length
        ? bindings.map((binding) => `${binding.HostIp || "0.0.0.0"}:${binding.HostPort}`).join(", ")
        : "sin publicar";
      return `<tr><td>${escapeHtml(publicValue)}</td><td>${escapeHtml(containerPort)}</td></tr>`;
    })
    .join("");

  const networks = Object.entries(detail.networks || {})
    .map(
      ([name, network]) =>
        `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(network.IPAddress || "-")}</td><td>${escapeHtml(network.Gateway || "-")}</td></tr>`,
    )
    .join("");

  const mounts = (detail.mounts || [])
    .map(
      (mount) =>
        `<tr><td>${escapeHtml(mount.Source || mount.Name)}</td><td>${escapeHtml(mount.Destination)}</td><td>${escapeHtml(mount.Mode || (mount.RW ? "rw" : "ro"))}</td></tr>`,
    )
    .join("");

  document.querySelector("#ports").innerHTML = `
    <h3>Puertos</h3>
    <table class="table"><thead><tr><th>Equipo</th><th>Contenedor</th></tr></thead><tbody>${rows || "<tr><td colspan='2'>Sin puertos publicados</td></tr>"}</tbody></table>
    <h3>Redes</h3>
    <table class="table"><thead><tr><th>Nombre</th><th>IP</th><th>Gateway</th></tr></thead><tbody>${networks || "<tr><td colspan='3'>Sin redes</td></tr>"}</tbody></table>
    <h3>Volúmenes</h3>
    <table class="table"><thead><tr><th>Origen</th><th>Destino</th><th>Modo</th></tr></thead><tbody>${mounts || "<tr><td colspan='3'>Sin volúmenes</td></tr>"}</tbody></table>
  `;
}

function renderEnv(detail) {
  const rows = (detail.env || [])
    .map((item) => {
      const [key, ...rest] = item.split("=");
      const secret = /(KEY|TOKEN|SECRET|PASS|PASSWORD|COOKIE|SESSION)/i.test(key);
      return `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(secret ? "••••••••" : rest.join("="))}</td></tr>`;
    })
    .join("");

  document.querySelector("#env").innerHTML = `
    <div class="notice">Las variables sensibles se ocultan en esta vista. En próximos cortes añadiremos edición segura con backup automático.</div>
    <table class="table"><thead><tr><th>Variable</th><th>Valor</th></tr></thead><tbody>${rows || "<tr><td colspan='2'>Sin variables</td></tr>"}</tbody></table>
  `;
}

function renderFiles(detail) {
  const files = detail.files || {};
  const names = Object.keys(files);
  if (!names.length) {
    document.querySelector("#files").innerHTML = `<div class="notice">No se encontró compose de Umbrel para este contenedor.</div>`;
    return;
  }

  document.querySelector("#files").innerHTML = `
    <div class="notice">Modo prototipo: lectura segura del compose/manifiesto. La escritura se añadirá con backups y validación.</div>
    <select id="fileSelect" class="file-select">
      ${names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}
    </select>
    <pre class="codebox" id="fileContent">${escapeHtml(files[names[0]])}</pre>
  `;

  document.querySelector("#fileSelect").addEventListener("change", (event) => {
    document.querySelector("#fileContent").textContent = files[event.target.value] || "";
  });
}

function renderLogs() {
  document.querySelector("#logs").innerHTML = `
    <div class="row" style="margin-bottom: 12px;">
      <button id="loadLogs" type="button">Actualizar logs</button>
      <span class="meta">Últimas 400 líneas</span>
    </div>
    <pre class="codebox">${escapeHtml(state.logs || "Pulsa Actualizar logs para cargar salida del contenedor.")}</pre>
  `;
  document.querySelector("#loadLogs").addEventListener("click", loadLogs);
}

function renderDetail() {
  if (!state.detail) return;
  els.empty.classList.add("hidden");
  els.detail.classList.remove("hidden");
  els.title.textContent = state.detail.name;
  els.start.disabled = state.detail.state?.Running;
  els.stop.disabled = !state.detail.state?.Running;
  els.restart.disabled = !state.detail.state?.Running;

  renderOverview(state.detail);
  renderPorts(state.detail);
  renderEnv(state.detail);
  renderFiles(state.detail);
  renderLogs();
}

async function loadContainers() {
  state.containers = await api("/api/containers");
  renderList();
}

async function selectContainer(id) {
  state.selectedId = id;
  state.logs = "";
  renderList();
  state.detail = await api(`/api/containers/${encodeURIComponent(id)}`);
  renderDetail();
}

async function action(name) {
  if (!state.selectedId) return;
  await api(`/api/containers/${encodeURIComponent(state.selectedId)}/${name}`, { method: "POST" });
  toast(`Acción enviada: ${name}`);
  await loadContainers();
  await selectContainer(state.selectedId);
}

async function loadLogs() {
  if (!state.selectedId) return;
  const result = await api(`/api/containers/${encodeURIComponent(state.selectedId)}/logs`);
  state.logs = result.logs;
  renderLogs();
}

document.addEventListener("click", (event) => {
  const card = event.target.closest(".container-card");
  if (card) selectContainer(card.dataset.id).catch((error) => toast(error.message));

  const tab = event.target.closest(".tab");
  if (tab) {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#${tab.dataset.tab}`).classList.add("active");
  }
});

els.search.addEventListener("input", renderList);
els.refresh.addEventListener("click", () => loadContainers().catch((error) => toast(error.message)));
els.start.addEventListener("click", () => action("start").catch((error) => toast(error.message)));
els.stop.addEventListener("click", () => action("stop").catch((error) => toast(error.message)));
els.restart.addEventListener("click", () => action("restart").catch((error) => toast(error.message)));

loadContainers().catch((error) => toast(error.message));
