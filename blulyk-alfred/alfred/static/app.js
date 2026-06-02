const $ = (id) => document.getElementById(id);

const WIDGET_TYPES = new Set([
  "status_card", "metric_card", "metric_grid", "line_chart", "bar_chart", "table",
  "log_viewer", "markdown", "checklist", "form", "image_preview", "web_preview",
  "command_panel", "service_monitor", "calendar_panel", "file_panel", "chat_panel",
  "automation_panel", "iframe_sandbox"
]);

const state = {
  layout: { version: 1, widgets: [], canvas: { zoom: 1, offset: { x: 0, y: 0 }, grid: true } },
  selectedId: null,
  drag: null,
  resize: null,
  pan: null,
  view: { x: 0, y: 0, scale: 1 },
  history: [],
  audit: [],
  toolData: new Map(),
  timers: new Map(),
  readonly: false,
  voice: { status: "idle", recognition: null, speechEnabled: false },
  visualIntensity: 0.75
};

window.addEventListener("load", boot);

async function boot() {
  bindChrome();
  resetView();
  await loadLayout();
  await refreshStatus();
  await refreshBrainStatus();
  await loadAudit();
  renderInspector("chat");
  renderHints();
  setInterval(refreshStatus, 30000);
  setInterval(refreshBrainStatus, 45000);
}

function bindChrome() {
  $("commandBar").addEventListener("submit", onCommandSubmit);
  $("micButton").addEventListener("click", togglePushToTalk);
  $("clearInput").addEventListener("click", () => $("commandInput").value = "");
  $("centerCanvas").addEventListener("click", resetView);
  $("syncCanvas").addEventListener("click", () => loadLayout(true));
  $("openConfig").addEventListener("click", () => renderInspector("config"));
  $("closeInspector").addEventListener("click", () => $("inspector").classList.remove("open"));
  $("jarvisCore").addEventListener("click", () => renderInspector("chat"));
  $("canvasViewport").addEventListener("wheel", onWheel, { passive: false });
  $("canvasViewport").addEventListener("pointerdown", onCanvasPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endPointerAction);
  window.addEventListener("keydown", onKeyDown);
  document.querySelectorAll("[data-panel]").forEach((button) => {
    button.addEventListener("click", () => renderInspector(button.dataset.panel));
  });
  document.querySelectorAll("[data-demo]").forEach((button) => {
    button.addEventListener("click", () => executeCommand(demoCommand(button.dataset.demo)));
  });
}

async function loadLayout(showToast = false) {
  const started = performance.now();
  const data = await getJson("/widgets");
  state.layout = data;
  state.selectedId = state.layout.widgets[0]?.id || null;
  renderWidgets();
  scheduleAllRefreshes();
  $("latencyState").textContent = `${Math.round(performance.now() - started)} ms`;
  if (showToast) toast("Canvas sincronizado.");
}

async function refreshStatus() {
  try {
    const vitals = await getJson("/vitals");
    $("systemState").textContent = `${vitals.status} · CPU ${percent(vitals.cpu_percent)} · RAM ${percent(vitals.ram_percent)}`;
    setCoreStatus("idle");
  } catch {
    $("systemState").textContent = "Offline";
    setCoreStatus("error");
  }
}

async function refreshBrainStatus() {
  try {
    const brain = await getJson("/brain/status");
    const primary = brain.primary || {};
    const fallback = brain.fallback || {};
    const label = primary.state === "ready" ? "Codex ready" : fallback.state === "ready" || fallback.state === "configured" ? "Gemini fallback" : "Brain setup";
    $("modelState").textContent = label;
    $("modelState").title = `${primary.detail || ""} ${fallback.detail || ""}`.trim();
  } catch {
    $("modelState").textContent = "Brain offline";
  }
}

async function loadAudit() {
  try {
    state.audit = await getJson("/audit?limit=80");
  } catch {
    state.audit = [];
  }
}

async function onCommandSubmit(event) {
  event.preventDefault();
  const input = $("commandInput");
  const command = input.value.trim();
  if (!command) return;
  input.value = "";
  await executeCommand(command);
}

async function executeCommand(command) {
  state.history.unshift(command);
  state.history = state.history.slice(0, 8);
  setCoreStatus("thinking");
  toast("JARVIS procesando comando.");
  try {
    const data = await getJson("/widgets/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, selected_widget_id: state.selectedId })
    });
    if (data.requiresConfirmation) {
      renderInspector("confirm", data);
      setCoreStatus("idle");
      return;
    }
    state.layout = data.layout;
    if (data.widget) state.selectedId = data.widget.id;
    renderWidgets();
    scheduleAllRefreshes();
    await loadAudit();
    renderHints();
    toast(data.message || "Comando ejecutado.");
    setCoreStatus("success");
    setTimeout(() => setCoreStatus("idle"), 700);
  } catch (error) {
    toast(error.message);
    setCoreStatus("error");
  }
}

function renderWidgets() {
  const layer = $("widgetLayer");
  layer.innerHTML = "";
  state.layout.widgets.forEach((manifest) => {
    const element = document.createElement("article");
    element.className = `widget-frame ${manifest.id === state.selectedId ? "selected" : ""}`;
    element.dataset.widgetId = manifest.id;
    element.style.transform = `translate3d(${manifest.layout.x}px, ${manifest.layout.y}px, 0)`;
    element.style.width = `${manifest.layout.w}px`;
    element.style.height = `${manifest.layout.h}px`;
    element.style.zIndex = manifest.layout.zIndex;
    element.innerHTML = widgetFrameHtml(manifest);
    bindWidgetElement(element, manifest);
    layer.appendChild(element);
    refreshWidgetData(manifest).catch(() => {});
  });
}

function widgetFrameHtml(widget) {
  return `
    <header class="widget-toolbar" data-drag-handle>
      <div>
        <span class="widget-status ${escapeHtml(widget.status)}">${escapeHtml(widget.status)}</span>
        <h3>${escapeHtml(widget.title)}</h3>
        ${widget.description ? `<p>${escapeHtml(widget.description)}</p>` : ""}
      </div>
      <div class="widget-actions">
        <button data-widget-action="refresh" aria-label="Refrescar">↻</button>
        <button data-widget-action="expand" aria-label="Expandir">□</button>
        <button data-widget-action="pin" aria-label="Fijar">⌖</button>
        <button data-widget-action="duplicate" aria-label="Duplicar">⧉</button>
        <button data-widget-action="config" aria-label="Configurar">⚙</button>
        <button data-widget-action="close" aria-label="Cerrar">×</button>
      </div>
    </header>
    <section class="widget-body" data-widget-body>${renderWidgetBody(widget)}</section>
    <footer class="widget-foot"><span data-last-updated>Sin actualizar</span><span>${escapeHtml(widget.type)}</span></footer>
    <button class="resize-handle" data-resize-handle aria-label="Redimensionar"></button>`;
}

function renderWidgetBody(widget) {
  if (!WIDGET_TYPES.has(widget.type)) return errorState("Tipo de widget no soportado.");
  if (widget.status === "error") return errorState("El widget informó de un error.");
  const data = state.toolData.get(widget.id);
  switch (widget.type) {
    case "status_card": return statusCard(widget, data);
    case "metric_card": return metricCard(widget, data);
    case "metric_grid": return metricGrid(widget, data);
    case "line_chart": return chartWidget(widget, data, "line");
    case "bar_chart": return chartWidget(widget, data, "bar");
    case "table": return tableWidget(widget, data);
    case "log_viewer": return logViewer(widget, data);
    case "markdown": return markdownWidget(widget);
    case "checklist": return checklistWidget(widget);
    case "form": return formWidget(widget);
    case "image_preview": return imagePreview(widget);
    case "web_preview": return webPreview(widget);
    case "command_panel": return commandPanel(widget);
    case "service_monitor": return serviceMonitor(widget, data);
    case "calendar_panel": return calendarPanel(widget, data);
    case "file_panel": return filePanel(widget);
    case "chat_panel": return chatPanel(widget);
    case "automation_panel": return automationPanel(widget);
    case "iframe_sandbox": return iframeSandbox(widget);
    default: return emptyState("Preparado.");
  }
}

function bindWidgetElement(element, widget) {
  element.addEventListener("pointerdown", (event) => {
    if (isInteractiveTarget(event.target) || event.target.closest("[data-drag-handle], [data-resize-handle]")) return;
    selectWidget(widget.id);
  });
  element.querySelectorAll(".widget-actions button").forEach((button) => {
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
  });
  element.querySelector("[data-drag-handle]").addEventListener("pointerdown", (event) => {
    if (state.readonly || widget.layout.locked || event.target.closest("button")) return;
    state.drag = { id: widget.id, x: event.clientX, y: event.clientY, ox: widget.layout.x, oy: widget.layout.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  element.querySelector("[data-resize-handle]").addEventListener("pointerdown", (event) => {
    if (state.readonly || widget.layout.locked) return;
    event.stopPropagation();
    state.resize = { id: widget.id, x: event.clientX, y: event.clientY, ow: widget.layout.w, oh: widget.layout.h };
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  element.addEventListener("click", (event) => {
    const action = event.target.closest("[data-widget-action]")?.dataset.widgetAction;
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      handleWidgetChromeAction(widget, action);
    }
  });
  bindWidgetBodyActions(element, widget);
}

function bindWidgetBodyActions(element, widget) {
  element.querySelectorAll("[data-run-action]").forEach((button) => {
    button.addEventListener("click", () => runWidgetAction(widget, button.dataset.runAction));
  });
  element.querySelectorAll("[data-check-id]").forEach((input) => {
    input.addEventListener("change", () => updateChecklist(widget, input.dataset.checkId, input.checked));
  });
  element.querySelectorAll("[data-form-submit]").forEach((button) => {
    button.addEventListener("click", () => toast("Entrada manual registrada localmente."));
  });
  element.querySelectorAll("[data-form-action]").forEach((button) => {
    button.addEventListener("click", () => runFormAction(widget, button.dataset.formAction));
  });
  element.querySelectorAll("[data-run-command]").forEach((button) => {
    button.addEventListener("click", () => executeCommand(button.dataset.runCommand));
  });
}

function selectWidget(id) {
  state.selectedId = id;
  const maxZ = Math.max(1, ...state.layout.widgets.map((item) => item.layout.zIndex));
  const widget = getWidget(id);
  if (widget && !widget.layout.pinned) {
    widget.layout.zIndex = maxZ + 1;
    saveWidgetPatch(id, { layout: { zIndex: widget.layout.zIndex } }).catch(() => {});
  }
  renderWidgets();
}

async function handleWidgetChromeAction(widget, action) {
  state.selectedId = widget.id;
  if (action === "refresh") return refreshWidgetData(widget, true);
  if (action === "close") return deleteWidget(widget.id);
  if (action === "duplicate") return duplicateWidget(widget.id);
  if (action === "config") return renderInspector("widget", widget);
  if (action === "pin") return saveAndReload(widget.id, { layout: { pinned: !widget.layout.pinned } });
  if (action === "expand") return saveAndReload(widget.id, { layout: { expanded: !widget.layout.expanded, w: widget.layout.expanded ? 420 : 760, h: widget.layout.expanded ? 280 : 560 } });
}

async function saveWidgetPatch(id, patch) {
  const data = await getJson(`/widgets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch })
  });
  state.layout = data.layout;
  return data;
}

async function saveAndReload(id, patch) {
  await saveWidgetPatch(id, patch);
  renderWidgets();
}

async function deleteWidget(id) {
  const data = await getJson(`/widgets/${encodeURIComponent(id)}`, { method: "DELETE" });
  state.layout = data.layout;
  state.selectedId = state.layout.widgets[0]?.id || null;
  renderWidgets();
  await loadAudit();
}

async function duplicateWidget(id) {
  const data = await getJson(`/widgets/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
  state.layout = data.layout;
  state.selectedId = data.widget.id;
  renderWidgets();
}

async function runWidgetAction(widget, actionId) {
  const action = widget.actions.find((item) => item.id === actionId);
  const confirmRun = !action?.requiresConfirmation || confirm(`Ejecutar "${action.label}" (${action.dangerLevel})?`);
  if (!confirmRun) return;
  const data = await getJson(`/widgets/${encodeURIComponent(widget.id)}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action_id: actionId, confirm: true })
  });
  toast(data.result?.error || data.result?.result?.message || "Acción ejecutada.");
  await loadAudit();
}

async function refreshWidgetData(widget, manual = false) {
  const source = widget.dataSource || { type: "mock" };
  let data = mockDataFor(widget);
  try {
    if (source.type === "internal_tool" && source.toolName) {
      const response = await getJson("/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: source.toolName, arguments: source.params || {} })
      });
      data = response.result || response;
    } else if (source.type === "http_endpoint" && safeUrl(source.endpoint || "")) {
      data = await getJson(source.endpoint);
    } else if (source.type === "static") {
      data = source.params || {};
    }
    state.toolData.set(widget.id, data);
    const frame = document.querySelector(`[data-widget-id="${CSS.escape(widget.id)}"]`);
    if (frame) {
      frame.querySelector("[data-widget-body]").innerHTML = renderWidgetBody(widget);
      frame.querySelector("[data-last-updated]").textContent = `Actualizado ${new Date().toLocaleTimeString()}`;
      bindWidgetBodyActions(frame, widget);
    }
    if (manual) toast(`${widget.title} actualizado.`);
  } catch (error) {
    state.toolData.set(widget.id, { error: error.message });
  }
}

function scheduleAllRefreshes() {
  state.timers.forEach((timer) => clearInterval(timer));
  state.timers.clear();
  state.layout.widgets.forEach((widget) => {
    const interval = widget.refreshInterval || widget.dataSource?.refreshInterval || 0;
    if (interval > 0) {
      state.timers.set(widget.id, setInterval(() => refreshWidgetData(widget), interval));
    }
  });
}

function onPointerMove(event) {
  if (state.pan) {
    state.view.x = state.pan.ox + event.clientX - state.pan.x;
    state.view.y = state.pan.oy + event.clientY - state.pan.y;
    applyView();
    return;
  }
  if (state.drag) {
    const widget = getWidget(state.drag.id);
    if (!widget) return;
    widget.layout.x = snap(state.drag.ox + (event.clientX - state.drag.x) / state.view.scale);
    widget.layout.y = snap(state.drag.oy + (event.clientY - state.drag.y) / state.view.scale);
    updateWidgetTransform(widget);
  }
  if (state.resize) {
    const widget = getWidget(state.resize.id);
    if (!widget) return;
    widget.layout.w = Math.max(260, snap(state.resize.ow + (event.clientX - state.resize.x) / state.view.scale));
    widget.layout.h = Math.max(180, snap(state.resize.oh + (event.clientY - state.resize.y) / state.view.scale));
    updateWidgetTransform(widget);
  }
}

function endPointerAction() {
  const changed = state.drag?.id || state.resize?.id;
  state.drag = null;
  state.resize = null;
  state.pan = null;
  if (changed) {
    const widget = getWidget(changed);
    if (widget) saveWidgetPatch(widget.id, { layout: widget.layout }).catch(() => {});
  }
}

function updateWidgetTransform(widget) {
  const element = document.querySelector(`[data-widget-id="${CSS.escape(widget.id)}"]`);
  if (!element) return;
  element.style.transform = `translate3d(${widget.layout.x}px, ${widget.layout.y}px, 0)`;
  element.style.width = `${widget.layout.w}px`;
  element.style.height = `${widget.layout.h}px`;
}

function onCanvasPointerDown(event) {
  if (event.target.closest(".widget-frame, .command-bar, .topbar, .sidebar, .inspector, .jarvis-core")) return;
  state.pan = { x: event.clientX, y: event.clientY, ox: state.view.x, oy: state.view.y };
}

function onWheel(event) {
  if (event.target.closest(".widget-frame, .command-bar, .inspector")) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) state.view.scale = Math.max(0.45, Math.min(1.8, state.view.scale * Math.exp(-event.deltaY * 0.002)));
  else {
    state.view.x -= event.deltaX;
    state.view.y -= event.deltaY;
  }
  applyView();
}

function resetView() {
  state.view = { x: window.innerWidth / 2, y: window.innerHeight / 2, scale: window.innerWidth < 760 ? 0.74 : 0.92 };
  applyView();
}

function applyView() {
  $("canvasWorld").style.transform = `translate3d(${state.view.x}px, ${state.view.y}px, 0) scale(${state.view.scale})`;
}

function onKeyDown(event) {
  if (event.ctrlKey && event.code === "Space") {
    event.preventDefault();
    togglePushToTalk();
  }
  if (event.key === "Escape") {
    stopVoice();
    $("inspector").classList.remove("open");
  }
}

function togglePushToTalk() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setVoiceStatus("error");
    toast("Este navegador no soporta Web Speech API.");
    return;
  }
  if (state.voice.recognition) {
    state.voice.recognition.stop();
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "es-ES";
  recognition.interimResults = true;
  recognition.continuous = false;
  state.voice.recognition = recognition;
  setVoiceStatus("listening");
  recognition.onresult = (event) => {
    const text = Array.from(event.results).map((item) => item[0].transcript).join(" ");
    $("commandInput").value = text;
    if (event.results[event.results.length - 1].isFinal) {
      setVoiceStatus("thinking");
      executeCommand(text);
    }
  };
  recognition.onerror = (event) => {
    setVoiceStatus("error");
    toast(`Micrófono: ${event.error}`);
  };
  recognition.onend = () => {
    state.voice.recognition = null;
    if (state.voice.status !== "thinking") setVoiceStatus("idle");
  };
  recognition.start();
}

function stopVoice() {
  if (state.voice.recognition) state.voice.recognition.stop();
  setVoiceStatus("idle");
}

function setVoiceStatus(status) {
  state.voice.status = status;
  $("micButton").dataset.status = status;
  setCoreStatus(status === "listening" ? "listening" : status);
}

function setCoreStatus(status) {
  $("appShell").dataset.core = status;
  $("coreState").textContent = status.toUpperCase();
}

function renderInspector(panel, data = null) {
  $("inspector").classList.add("open");
  const body = $("inspectorBody");
  $("inspectorEyebrow").textContent = panel;
  if (panel === "confirm") {
    $("inspectorTitle").textContent = "Confirmación requerida";
    body.innerHTML = `<p>${escapeHtml(data.message)}</p><button class="primary-button" id="confirmClear">Confirmar limpiar canvas</button>`;
    $("confirmClear").addEventListener("click", () => executeCommand("confirmar limpiar canvas"));
    return;
  }
  if (panel === "widget") {
    $("inspectorTitle").textContent = data.title;
    body.innerHTML = `<pre class="output">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    return;
  }
  if (panel === "config") {
    $("inspectorTitle").textContent = "Configuración";
    body.innerHTML = `
      <section class="config-group">
        <h3>Mente JARVIS</h3>
        <p id="brainSummary" class="muted">Comprobando Codex/Gemini...</p>
        <label>Google API key <input id="googleApiKey" type="password" placeholder="AIza..."></label>
        <label>Modelo Gemini <input id="googleModel" type="text" placeholder="gemini-2.5-flash-lite"></label>
        <button class="text-button" id="saveGoogleKey">Guardar Google</button>
        <button class="text-button" id="testGoogleKey">Probar Gemini</button>
        <label>Codex auth.json <textarea id="codexAuthJson" placeholder="Pega aqui el auth.json de Codex"></textarea></label>
        <button class="text-button" id="importCodexAuth">Importar Codex auth.json</button>
        <button class="text-button" id="startCodexLogin">Iniciar sesion Codex</button>
      </section>
      <label class="toggle"><input id="readonlyToggle" type="checkbox" ${state.readonly ? "checked" : ""}> Modo solo lectura</label>
      <label class="toggle"><input id="gridToggle" type="checkbox" ${state.layout.canvas.grid ? "checked" : ""}> Mostrar grid</label>
      <label>Intensidad visual <input id="visualRange" type="range" min="0.2" max="1" step="0.05" value="${state.visualIntensity}"></label>
      <button class="text-button" id="exportLayout">Exportar layout</button>
      <button class="text-button" id="importLayout">Importar layout</button>
      <button class="danger-button" id="clearCanvas">Limpiar canvas</button>
      <textarea id="layoutBuffer" placeholder="JSON de layout"></textarea>`;
    $("readonlyToggle").addEventListener("change", (e) => state.readonly = e.target.checked);
    $("gridToggle").addEventListener("change", (e) => $("appShell").classList.toggle("no-grid", !e.target.checked));
    $("visualRange").addEventListener("input", (e) => document.documentElement.style.setProperty("--visual", e.target.value));
    $("exportLayout").addEventListener("click", () => $("layoutBuffer").value = JSON.stringify(state.layout, null, 2));
    $("importLayout").addEventListener("click", importLayout);
    $("clearCanvas").addEventListener("click", () => renderInspector("confirm", { message: "¿Limpiar todos los widgets del canvas?" }));
    $("saveGoogleKey").addEventListener("click", saveGoogleKey);
    $("testGoogleKey").addEventListener("click", testGoogleKey);
    $("importCodexAuth").addEventListener("click", importCodexAuth);
    $("startCodexLogin").addEventListener("click", startCodexLogin);
    updateBrainSummary();
    return;
  }
  if (panel === "memory" || panel === "tools") {
    $("inspectorTitle").textContent = panel === "memory" ? "Audit log" : "Herramientas";
    body.innerHTML = panel === "memory" ? auditHtml() : toolsHtml();
    return;
  }
  $("inspectorTitle").textContent = "Chat y comandos";
  body.innerHTML = `
    <div class="suggestion-list">
      ${[
        "crea un monitor de red",
        "crea un widget de logs",
        "crea un dashboard con CPU RAM y disco",
        "crea un preview de URL",
        "crea un checklist de tareas",
        "mueve el widget arriba a la derecha",
        "hazlo más grande",
        "actualízalo cada 10 segundos"
      ].map((item) => `<button data-suggestion="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}
    </div>`;
  body.querySelectorAll("[data-suggestion]").forEach((button) => button.addEventListener("click", () => executeCommand(button.dataset.suggestion)));
}

function renderHints() {
  $("commandHints").innerHTML = state.history.map((item) => `<button type="button" data-history="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("");
  $("commandHints").querySelectorAll("[data-history]").forEach((button) => button.addEventListener("click", () => $("commandInput").value = button.dataset.history));
}

async function importLayout() {
  try {
    const layout = JSON.parse($("layoutBuffer").value);
    const data = await getJson("/widgets/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layout })
    });
    state.layout = data.layout;
    renderWidgets();
    toast("Layout importado.");
  } catch (error) {
    toast(`Importación inválida: ${error.message}`);
  }
}

function statusCard(widget, data) {
  const status = data?.status || data?.vitals?.status || widget.status;
  return `<div class="big-status"><strong>${escapeHtml(status)}</strong><span>${escapeHtml(widget.description || "Estado operativo")}</span></div>`;
}

function metricCard(widget, data) {
  const key = widget.config.key || "value";
  return `<div class="metric-solo"><span>${escapeHtml(widget.config.label || key)}</span><strong>${escapeHtml(data?.[key] ?? "--")}${escapeHtml(widget.config.suffix || "")}</strong></div>`;
}

function metricGrid(widget, data) {
  const metrics = widget.config.metrics || [];
  return `<div class="widget-metrics">${metrics.map((metric) => `<article><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(data?.[metric.key] ?? "--")}${escapeHtml(metric.suffix || "")}</strong></article>`).join("") || emptyState("Sin métricas configuradas.")}</div>`;
}

function chartWidget(widget, data, kind) {
  const values = widget.config.values || [24, 38, 31, 52, 44, 68, 59];
  const bars = values.map((value) => `<span style="height:${Math.max(8, Number(value))}%"></span>`).join("");
  return `<div class="chart ${kind}">${bars}</div><small class="muted">Datos ${data?.mock ? "mock" : "preparados"}</small>`;
}

function tableWidget(widget, data) {
  const columns = widget.config.columns || ["Nombre", "Estado"];
  const rows = widget.config.rows || data?.rows || [];
  return `<table><thead><tr>${columns.map((item) => `<th>${escapeHtml(item)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function logViewer(widget, data) {
  const logs = Array.isArray(data) ? data : state.audit;
  return `<div class="log-lines">${logs.slice(0, widget.config.limit || 20).map((item) => `<p><span>${escapeHtml(item.severity || "info")}</span>${escapeHtml(item.message || item.summary || JSON.stringify(item))}</p>`).join("") || emptyState("Sin logs.")}</div>`;
}

function markdownWidget(widget) {
  return `<div class="markdown">${sanitizeMarkdown(widget.config.markdown || "### JARVIS\nWidget markdown seguro.")}</div>`;
}

function checklistWidget(widget) {
  const items = widget.config.items || [];
  return `<div class="checklist">${items.map((item) => `<label><input data-check-id="${escapeHtml(item.id)}" type="checkbox" ${item.done ? "checked" : ""}> ${escapeHtml(item.text)}</label>`).join("")}</div>`;
}

function formWidget(widget) {
  const fields = widget.config.fields || [];
  const actions = widget.config.actions || [];
  return `<div class="form-widget">
    ${fields.map((field) => formField(field)).join("")}
    <div class="form-actions">
      ${actions.map((action) => `<button type="button" data-form-action="${escapeHtml(action.id)}">${escapeHtml(action.label || "Ejecutar")}</button>`).join("") || `<button type="button" data-form-submit>Guardar</button>`}
    </div>
    <output data-form-output>${escapeHtml((widget.config.notes || []).join(" "))}</output>
  </div>`;
}

async function updateBrainSummary() {
  try {
    const brain = await getJson("/brain/status");
    const primary = brain.primary || {};
    const fallback = brain.fallback || {};
    const summary = `Codex: ${primary.state || "unknown"} · Gemini: ${fallback.state || "unknown"}`;
    const node = $("brainSummary");
    if (node) node.textContent = summary;
    await refreshBrainStatus();
  } catch (error) {
    const node = $("brainSummary");
    if (node) node.textContent = error.message;
  }
}

async function saveGoogleKey() {
  const apiKey = $("googleApiKey").value.trim();
  const model = $("googleModel").value.trim();
  if (!apiKey) return toast("Introduce la API key de Google.");
  await getJson("/brain/google-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, model: model || null })
  });
  $("googleApiKey").value = "";
  toast("Google Gemini guardado.");
  await updateBrainSummary();
}

async function testGoogleKey() {
  const data = await getJson("/brain/google-test", { method: "POST" });
  toast(data.response || data.detail || "Prueba ejecutada.");
  await updateBrainSummary();
}

async function importCodexAuth() {
  const authJson = $("codexAuthJson").value.trim();
  if (!authJson) return toast("Pega el auth.json de Codex.");
  await getJson("/brain/codex-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth_json: authJson })
  });
  $("codexAuthJson").value = "";
  toast("Codex auth.json importado.");
  await updateBrainSummary();
}

async function startCodexLogin() {
  const data = await getJson("/brain/codex-login", { method: "POST" });
  if (data.url) window.open(data.url, "_blank", "noopener,noreferrer");
  toast(data.code ? `Codigo Codex: ${data.code}` : data.detail || data.state || "Login Codex iniciado.");
  await updateBrainSummary();
}

function formField(field) {
  const id = escapeHtml(field.id || field.label || "value");
  const label = escapeHtml(field.label || id);
  const placeholder = escapeHtml(field.placeholder || "");
  if (field.type === "textarea") {
    return `<label>${label}<textarea data-form-field="${id}" placeholder="${placeholder}"></textarea></label>`;
  }
  if (field.type === "select") {
    const options = (field.options || []).map((option) => `<option>${escapeHtml(option)}</option>`).join("");
    return `<label>${label}<select data-form-field="${id}">${options}</select></label>`;
  }
  const type = ["search", "number", "url", "text"].includes(field.type) ? field.type : "text";
  return `<label>${label}<input data-form-field="${id}" type="${type}" placeholder="${placeholder}"></label>`;
}

async function runFormAction(widget, actionId) {
  const frame = document.querySelector(`[data-widget-id="${CSS.escape(widget.id)}"]`);
  const action = (widget.config.actions || []).find((item) => item.id === actionId);
  if (!frame || !action) return;
  const values = {};
  frame.querySelectorAll("[data-form-field]").forEach((field) => values[field.dataset.formField] = field.value);
  const output = frame.querySelector("[data-form-output]");
  try {
    if (action.type === "open_url") {
      const url = applyTemplate(action.urlTemplate || "", values);
      if (!safeUrl(url)) throw new Error("URL no permitida.");
      window.open(url, "_blank", "noopener,noreferrer");
      output.textContent = `Abierto: ${url}`;
      return;
    }
    if (action.type === "calculate_expression") {
      const expression = values[action.field] || values.expression || Object.values(values)[0] || "";
      output.textContent = calculateExpression(expression);
      return;
    }
    if (action.type === "tool_call") {
      const data = await getJson("/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: action.tool, arguments: action.arguments || values })
      });
      output.textContent = JSON.stringify(data.result || data, null, 2);
      return;
    }
    if (action.type === "ask_jarvis") {
      const prompt = applyTemplate(action.promptTemplate || Object.values(values).join(" "), values);
      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt })
      });
      output.textContent = await response.text();
      return;
    }
    const field = action.field || Object.keys(values)[0];
    output.textContent = values[field] || JSON.stringify(values);
  } catch (error) {
    output.textContent = error.message;
  }
}

function imagePreview(widget) {
  const url = safeUrl(widget.config.url || "") ? widget.config.url : "";
  return url ? `<img class="preview-image" src="${escapeHtml(url)}" alt="${escapeHtml(widget.title)}">` : emptyState("Configura una URL http/https de imagen.");
}

function webPreview(widget) {
  const url = safeUrl(widget.config.url || "") ? widget.config.url : "about:blank";
  return `<iframe class="preview-frame" sandbox="allow-forms allow-scripts" src="${escapeHtml(url)}" title="${escapeHtml(widget.title)}"></iframe>`;
}

function commandPanel(widget) {
  return `<div class="command-panel">${widget.actions.map((action) => `<button class="${action.dangerLevel !== "low" ? "danger-button" : "text-button"}" data-run-action="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`).join("") || emptyState("Sin acciones.")}</div>`;
}

function serviceMonitor(widget, data) {
  const services = data?.services || [];
  return `<div class="service-list">${services.map((svc) => `<div><strong>${escapeHtml(svc.name)}</strong><span>${escapeHtml(svc.status)}${svc.mock ? " · mock" : ""}</span></div>`).join("") || emptyState("Sin servicios.")}</div>`;
}

function calendarPanel(widget, data) {
  const events = data?.events || [{ title: "Mock calendar", when: "Preparado" }];
  return `<div class="service-list">${events.map((event) => `<div><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.when)}</span></div>`).join("")}</div>`;
}

function filePanel(widget) {
  return `<div class="service-list"><div><strong>/data</strong><span>Conector preparado</span></div><div><strong>workspace</strong><span>Mock</span></div></div>`;
}

function chatPanel(widget) {
  return `<div class="chat-mini"><p>Panel conectado a Codex/Gemini.</p><button class="text-button" data-run-command="crea un panel de estado del sistema">Crear estado</button></div>`;
}

function automationPanel(widget) {
  return `<div class="service-list"><div><strong>n8n</strong><span>Preparado para conexión</span></div><div><strong>Telegram</strong><span>Preparado</span></div></div>`;
}

function iframeSandbox(widget) {
  const url = safeUrl(widget.config.url || "") ? widget.config.url : "about:blank";
  return `<iframe class="preview-frame" sandbox="allow-scripts allow-forms" src="${escapeHtml(url)}" title="${escapeHtml(widget.title)}"></iframe>`;
}

function updateChecklist(widget, id, checked) {
  const items = (widget.config.items || []).map((item) => item.id === id ? { ...item, done: checked } : item);
  saveAndReload(widget.id, { config: { ...widget.config, items } });
}

function mockDataFor(widget) {
  if (widget.type === "service_monitor") return { services: [{ name: "JARVIS", status: "online" }, { name: "Codex", status: "pending-auth" }, { name: "Gemini", status: "fallback" }] };
  return { mock: true, status: "mock-ready", value: 42, cpu: 38, ram: 51, disk: 22, latency: 24, download: 240, upload: 80 };
}

function auditHtml() {
  return `<div class="log-lines">${state.audit.map((item) => `<p><span>${escapeHtml(item.type)}</span>${escapeHtml(item.message)}</p>`).join("") || emptyState("Sin audit log.")}</div>`;
}

function toolsHtml() {
  return `<div class="service-list">${["get_system_status", "get_network_status", "get_cpu_ram_status", "get_storage_status", "get_recent_logs", "get_service_status", "get_calendar_preview", "get_assets_list", "sync_workspace"].map((item) => `<div><strong>${item}</strong><span>Disponible para widgets</span></div>`).join("")}</div>`;
}

function demoCommand(kind) {
  return {
    system: "crea un dashboard con CPU RAM y disco",
    logs: "crea un widget de logs",
    assets: "crea una tabla de assets",
    automation: "crea un panel de automatizaciones"
  }[kind] || "crea un widget de métricas";
}

function getWidget(id) {
  return state.layout.widgets.find((item) => item.id === id);
}

function snap(value) {
  return state.layout.canvas.grid ? Math.round(value / 12) * 12 : Math.round(value);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function applyTemplate(template, values) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => encodeURIComponent(values[key] || ""));
}

function calculateExpression(expression) {
  const clean = String(expression || "").replace(/\s+/g, "");
  if (!/^[0-9+\-*/().,%]+$/.test(clean)) return "Operacion no permitida.";
  const normalized = clean.replaceAll("%", "/100");
  try {
    const result = Function(`"use strict"; return (${normalized})`)();
    return Number.isFinite(result) ? String(result) : "Resultado invalido.";
  } catch {
    return "Operacion invalida.";
  }
}

function isInteractiveTarget(target) {
  return !!target.closest("button, input, textarea, select, a, iframe, [data-form-field], [data-form-action], [data-run-action], [data-widget-action]");
}

function sanitizeMarkdown(value) {
  return escapeHtml(value)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function emptyState(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function errorState(text) {
  return `<div class="error-state">${escapeHtml(text)}</div>`;
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      detail = payload.detail || detail;
    } catch {}
    throw new Error(detail);
  }
  return response.json();
}

function percent(value) {
  return typeof value === "number" ? `${value.toFixed(0)}%` : "--";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  setTimeout(() => $("toast").classList.remove("visible"), 2600);
}
