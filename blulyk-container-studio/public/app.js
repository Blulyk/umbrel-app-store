const state = {
  apps: [],
  selectedId: null,
  detail: null,
  logs: "",
  activeService: "",
};

const els = {
  grid: document.querySelector("#appGrid"),
  count: document.querySelector("#appCount"),
  search: document.querySelector("#search"),
  refresh: document.querySelector("#refresh"),
  detail: document.querySelector("#detail"),
  empty: document.querySelector("#emptyState"),
  title: document.querySelector("#appTitle"),
  icon: document.querySelector("#detailIcon"),
  meta: document.querySelector("#detailMeta"),
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
  toast.timer = setTimeout(() => els.toast.classList.add("hidden"), 4200);
}

function stateClass(app) {
  return app.state === "running" ? "running" : app.state === "partial" ? "partial" : "stopped";
}

function stateLabel(app) {
  if (app.state === "running") return "activa";
  if (app.state === "partial") return "parcial";
  return "parada";
}

function renderGrid() {
  const query = els.search.value.trim().toLowerCase();
  const apps = state.apps.filter((app) => {
    const haystack = `${app.name} ${app.id} ${app.tagline} ${app.primaryImage}`.toLowerCase();
    return haystack.includes(query);
  });

  els.count.textContent = `${apps.length} apps`;
  els.grid.innerHTML = apps
    .map(
      (app) => `
        <button class="app-card ${app.id === state.selectedId ? "active" : ""}" data-id="${escapeHtml(app.id)}">
          <img class="app-icon" src="${escapeHtml(app.icon)}" alt="" loading="lazy" />
          <div class="app-copy">
            <div class="row">
              <span class="name">${escapeHtml(app.name)}</span>
              <span class="chip ${stateClass(app)}">${stateLabel(app)}</span>
            </div>
            <p>${escapeHtml(app.tagline || app.primaryImage || app.id)}</p>
            <div class="row">
              <span class="meta">${escapeHtml(app.version ? `v${app.version}` : app.id)}</span>
              <span class="meta">${app.running}/${app.containers} contenedores</span>
            </div>
          </div>
        </button>
      `,
    )
    .join("");
}

function visibleServices() {
  return (state.detail?.services || []).filter((service) => !service.isProxy);
}

function currentService() {
  return visibleServices().find((service) => service.name === state.activeService) || visibleServices()[0];
}

function renderField(label, value) {
  return `
    <div class="field">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value || "-")}</div>
    </div>
  `;
}

function renderOverview() {
  const detail = state.detail;
  const services = visibleServices();
  document.querySelector("#overview").innerHTML = `
    <div class="grid">
      ${renderField("App ID", detail.id)}
      ${renderField("Version", detail.version)}
      ${renderField("Categoria", detail.category)}
      ${renderField("Puerto Umbrel", detail.port)}
      ${renderField("Servicios configurables", services.map((service) => service.name).join(", "))}
      ${renderField("Contenedores activos", `${detail.containers.filter((container) => container.state === "running").length}/${detail.containers.length}`)}
    </div>
    <h3>Servicios</h3>
    <table class="table">
      <thead><tr><th>Servicio</th><th>Imagen</th><th>Estado</th></tr></thead>
      <tbody>
        ${services
          .map(
            (service) =>
              `<tr><td>${escapeHtml(service.name)}</td><td>${escapeHtml(service.image)}</td><td>${escapeHtml(service.containers.map((item) => item.status).join(", ") || "sin contenedor")}</td></tr>`,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderPorts() {
  const services = visibleServices();
  const rows = services
    .flatMap((service) =>
      service.containers.flatMap((container) =>
        (container.ports || []).map(
          (port) =>
            `<tr><td>${escapeHtml(service.name)}</td><td>${escapeHtml(port.PublicPort ? `${port.IP || "0.0.0.0"}:${port.PublicPort}` : "sin publicar")}</td><td>${escapeHtml(`${port.PrivatePort}/${port.Type}`)}</td></tr>`,
        ),
      ),
    )
    .join("");

  const volumes = services
    .flatMap((service) => (service.volumes || []).map((volume) => `<tr><td>${escapeHtml(service.name)}</td><td>${escapeHtml(volume)}</td></tr>`))
    .join("");

  document.querySelector("#ports").innerHTML = `
    <h3>Puertos</h3>
    <table class="table"><thead><tr><th>Servicio</th><th>Equipo</th><th>Contenedor</th></tr></thead><tbody>${rows || "<tr><td colspan='3'>Sin puertos publicados</td></tr>"}</tbody></table>
    <h3>Volumenes definidos</h3>
    <table class="table"><thead><tr><th>Servicio</th><th>Mapeo</th></tr></thead><tbody>${volumes || "<tr><td colspan='2'>Sin volumenes en compose</td></tr>"}</tbody></table>
  `;
}

function variableRow(variable = { key: "", value: "" }) {
  return `
    <tr class="env-row">
      <td><input class="env-key" value="${escapeHtml(variable.key)}" placeholder="NOMBRE_VARIABLE" spellcheck="false" /></td>
      <td><input class="env-value" value="${escapeHtml(variable.value)}" placeholder="valor" spellcheck="false" /></td>
      <td><button class="remove-env" type="button">Eliminar</button></td>
    </tr>
  `;
}

function renderEnv() {
  const services = visibleServices();
  if (!services.length) {
    document.querySelector("#env").innerHTML = `<div class="notice">Esta app no tiene servicios configurables fuera de app_proxy.</div>`;
    return;
  }
  if (!state.activeService) state.activeService = services[0].name;
  const service = currentService();

  document.querySelector("#env").innerHTML = `
    <div class="notice">Al guardar se crea un backup del docker-compose.yml, se escribe la nueva configuracion y se recrea el servicio para aplicar las variables.</div>
    <div class="env-toolbar">
      <label>
        Servicio
        <select id="serviceSelect">
          ${services.map((item) => `<option value="${escapeHtml(item.name)}" ${item.name === service.name ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
        </select>
      </label>
      <button id="addEnv" type="button">+ Variable</button>
      <button id="saveEnv" type="button">Guardar y reiniciar</button>
    </div>
    <table class="table env-table">
      <thead><tr><th>Variable</th><th>Valor</th><th></th></tr></thead>
      <tbody id="envRows">
        ${(service.environment || []).map(variableRow).join("") || variableRow()}
      </tbody>
    </table>
  `;

  document.querySelector("#serviceSelect").addEventListener("change", (event) => {
    state.activeService = event.target.value;
    renderEnv();
  });
  document.querySelector("#addEnv").addEventListener("click", () => {
    document.querySelector("#envRows").insertAdjacentHTML("beforeend", variableRow());
  });
  document.querySelector("#saveEnv").addEventListener("click", saveEnv);
}

function renderFiles() {
  const files = state.detail.files || {};
  const names = Object.keys(files).filter((name) => files[name]);
  if (!names.length) {
    document.querySelector("#files").innerHTML = `<div class="notice">No se encontraron archivos de Umbrel para esta app.</div>`;
    return;
  }

  document.querySelector("#files").innerHTML = `
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
  const services = visibleServices();
  const selected = currentService()?.name || "";
  document.querySelector("#logs").innerHTML = `
    <div class="env-toolbar">
      <select id="logService">
        ${services.map((service) => `<option value="${escapeHtml(service.name)}" ${service.name === selected ? "selected" : ""}>${escapeHtml(service.name)}</option>`).join("")}
      </select>
      <button id="loadLogs" type="button">Actualizar logs</button>
      <span class="meta">Ultimas 400 lineas</span>
    </div>
    <pre class="codebox">${escapeHtml(state.logs || "Pulsa Actualizar logs para cargar salida del servicio.")}</pre>
  `;
  document.querySelector("#loadLogs").addEventListener("click", loadLogs);
}

function renderDetail() {
  if (!state.detail) return;
  els.empty.classList.add("hidden");
  els.detail.classList.remove("hidden");
  els.title.textContent = state.detail.name;
  els.icon.src = state.detail.icon || "/icon.svg";
  els.meta.textContent = `${state.detail.id}${state.detail.version ? ` · v${state.detail.version}` : ""}`;
  els.restart.disabled = false;

  renderEnv();
  renderOverview();
  renderPorts();
  renderFiles();
  renderLogs();
}

async function loadApps() {
  state.apps = await api("/api/apps");
  renderGrid();
}

async function selectApp(id) {
  state.selectedId = id;
  state.logs = "";
  state.activeService = "";
  renderGrid();
  state.detail = await api(`/api/apps/${encodeURIComponent(id)}`);
  renderDetail();
}

function collectVariables() {
  return [...document.querySelectorAll(".env-row")]
    .map((row) => ({
      key: row.querySelector(".env-key").value.trim(),
      value: row.querySelector(".env-value").value,
    }))
    .filter((item) => item.key);
}

async function saveEnv() {
  const service = currentService();
  if (!state.selectedId || !service) return;
  const saveButton = document.querySelector("#saveEnv");
  saveButton.disabled = true;
  saveButton.textContent = "Guardando...";
  try {
    const result = await api(`/api/apps/${encodeURIComponent(state.selectedId)}/env`, {
      method: "POST",
      body: JSON.stringify({ service: service.name, variables: collectVariables() }),
    });
    toast(`Guardado. Backup: ${result.backup}`);
    await loadApps();
    await selectApp(state.selectedId);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Guardar y reiniciar";
  }
}

async function restartApp() {
  if (!state.selectedId) return;
  await api(`/api/apps/${encodeURIComponent(state.selectedId)}/restart`, { method: "POST" });
  toast("App reiniciada");
  await loadApps();
  await selectApp(state.selectedId);
}

async function loadLogs() {
  if (!state.selectedId) return;
  const service = document.querySelector("#logService")?.value || currentService()?.name || "";
  const result = await api(`/api/apps/${encodeURIComponent(state.selectedId)}/logs?service=${encodeURIComponent(service)}`);
  state.logs = result.logs;
  renderLogs();
}

document.addEventListener("click", (event) => {
  const card = event.target.closest(".app-card");
  if (card) selectApp(card.dataset.id).catch((error) => toast(error.message));

  const remove = event.target.closest(".remove-env");
  if (remove) remove.closest(".env-row")?.remove();

  const tab = event.target.closest(".tab");
  if (tab) {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#${tab.dataset.tab}`).classList.add("active");
  }
});

els.search.addEventListener("input", renderGrid);
els.refresh.addEventListener("click", () => loadApps().catch((error) => toast(error.message)));
els.restart.addEventListener("click", () => restartApp().catch((error) => toast(error.message)));

loadApps().catch((error) => toast(error.message));
