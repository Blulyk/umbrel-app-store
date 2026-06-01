const $ = (id) => document.getElementById(id);

const state = {
  view: { x: 0, y: 0, scale: 1 },
  targetView: { x: 0, y: 0, scale: 1 },
  widgets: [],
  nextWidgetId: 1,
  drag: null,
  pan: null,
  pinch: null,
  raf: 0,
  viewRaf: 0,
  lastAssistantText: "",
  recognition: null,
  listening: false,
  continuousListening: false,
  activeVoiceWidget: null,
  voices: [],
  codexLoginTimer: null,
  statusTimer: null
};

const widgetDefaults = {
  chat: { title: "JARVIS Chat", x: -430, y: 250, w: 860, h: 540 },
  metrics: { title: "Core Metrics", x: 360, y: -430, w: 430, h: 360 },
  config: { title: "Brain Link", x: -820, y: -420, w: 500, h: 520 },
  logs: { title: "Operational Logs", x: -910, y: 120, w: 470, h: 380 },
  assets: { title: "Remote Assets", x: 470, y: 110, w: 470, h: 430 },
  self: { title: "JARVIS Control", x: 120, y: -390, w: 470, h: 360 },
  terminal: { title: "Host Console", x: 120, y: 420, w: 560, h: 360 },
  live: { title: "Live Widget", x: 120, y: 420, w: 520, h: 360 },
  custom: { title: "Dynamic Widget", x: 120, y: 420, w: 420, h: 300 }
};

window.addEventListener("load", () => {
  setTimeout(() => $("arcApp").classList.remove("booting"), 2050);
  setupCanvas();
  setupCommands();
  resetView();
  loadVoices();
  refreshAll();
  loadGeneratedWidgets();
  state.statusTimer = setInterval(refreshAll, 30000);
});

function setupCanvas() {
  $("resetView").addEventListener("click", resetView);
  $("refreshAll").addEventListener("click", refreshAll);
  $("coreButton").addEventListener("click", () => {
    pulseCore();
    focusOrCreate("chat");
  });
  document.querySelectorAll(".dock-button").forEach((button) => {
    button.addEventListener("click", () => focusOrCreate(button.dataset.widget));
  });

  const viewport = $("canvasViewport");
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("pointerdown", onCanvasPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endPointerAction);
  window.addEventListener("pointercancel", endPointerAction);
  window.addEventListener("resize", resetView);
  if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = loadVoices;
  window.addEventListener("message", handleRuntimeMessage);
}

function setupCommands() {
  $("commandBar").addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = $("widgetCommandInput").value.trim();
    if (!prompt) return;
    $("widgetCommandInput").value = "";
    toast("JARVIS estÃ¡ diseÃ±ando el widget.");
    let spec;
    try {
      const data = await getJson("/widgets/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, existing_widgets: state.widgets.map((widget) => widget.type) })
      });
      spec = data.widget;
    } catch {
      const type = inferWidgetType(prompt);
      spec = { type, title: titleFromPrompt(prompt, type), description: prompt, query: prompt, refreshSeconds: 0 };
    }
    const widget = addWidget(spec.type, { prompt, spec, title: spec.title, x: 140, y: 140 });
    toast(`Widget aÃ±adido: ${widget.title}`);
    focusWidget(widget);
    if (spec.type === "chat") {
      const input = widget.element.querySelector("[data-role='prompt']");
      input.value = prompt;
      sendChatFromWidget(widget, prompt);
    }
  });
}

function resetView() {
  const viewport = $("canvasViewport");
  state.view.scale = window.innerWidth < 720 ? 0.72 : 0.9;
  state.view.x = viewport.clientWidth / 2;
  state.view.y = viewport.clientHeight / 2;
  state.targetView = { ...state.view };
  scheduleWorldTransform();
}

function onWheel(event) {
  if (event.target.closest(".hud-widget, .dock, .command-bar, .topbar")) {
    return;
  }
  event.preventDefault();
  if (event.ctrlKey || event.metaKey || event.altKey) {
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0028));
    return;
  }
  state.targetView.x -= event.deltaX;
  state.targetView.y -= event.deltaY;
  animateView();
}

function onCanvasPointerDown(event) {
  if (event.target.closest(".hud-widget, .arc-core, .dock, .command-bar, .topbar")) return;
  if (event.pointerType === "touch") {
    trackTouchPointer(event);
    return;
  }
  state.pan = { x: event.clientX, y: event.clientY, ox: state.targetView.x, oy: state.targetView.y };
  $("canvasViewport").setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (state.pinch && state.pinch.points.has(event.pointerId)) {
    state.pinch.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    updatePinch();
    return;
  }
  if (state.pan) {
    state.targetView.x = state.pan.ox + event.clientX - state.pan.x;
    state.targetView.y = state.pan.oy + event.clientY - state.pan.y;
    animateView();
    return;
  }
  if (!state.drag) return;
  const widget = state.widgets.find((item) => item.id === state.drag.id);
  if (!widget) return;
  const dx = (event.clientX - state.drag.x) / state.view.scale;
  const dy = (event.clientY - state.drag.y) / state.view.scale;
  if (state.drag.mode === "move") {
    widget.x = state.drag.ox + dx;
    widget.y = state.drag.oy + dy;
  } else {
    widget.w = clamp(state.drag.ow + dx, 300, 980);
    widget.h = clamp(state.drag.oh + dy, 220, 820);
  }
  scheduleWidgetTransform(widget);
}

function endPointerAction() {
  if (state.pinch) {
    state.pinch.points.clear();
    state.pinch = null;
  }
  state.pan = null;
  state.drag = null;
}

function addWidget(type, overrides = {}) {
  const defaults = widgetDefaults[type] || widgetDefaults.custom;
  const widget = {
    id: `w${state.nextWidgetId++}`,
    type,
    title: overrides.title || defaults.title,
    savedId: overrides.savedId || overrides.spec?.id || "",
    prompt: overrides.prompt || "",
    spec: overrides.spec || {},
    x: overrides.x ?? defaults.x,
    y: overrides.y ?? defaults.y,
    w: overrides.w ?? overrides.spec?.size?.w ?? defaults.w,
    h: overrides.h ?? overrides.spec?.size?.h ?? defaults.h
  };
  const element = document.createElement("article");
  element.className = `hud-widget widget-${type}`;
  element.dataset.widgetId = widget.id;
  element.innerHTML = widgetShell(widget);
  widget.element = element;
  $("widgetLayer").appendChild(element);
  state.widgets.push(widget);
  bindWidget(widget);
  scheduleWidgetTransform(widget);
  requestAnimationFrame(() => element.classList.add("online"));
  loadWidgetData(widget);
  return widget;
}

function widgetShell(widget) {
  return `
    <div class="widget-frame" aria-hidden="true"></div>
    <header class="widget-head" data-drag-handle>
      <div><p class="eyebrow">${escapeHtml(widget.type)}</p><h2>${escapeHtml(widget.title)}</h2></div>
      <div class="widget-actions">
        <button class="mini-button" data-action="refresh" type="button">SYNC</button>
        <button class="mini-button" data-action="close" type="button">X</button>
      </div>
    </header>
    <section class="widget-body">${widgetContent(widget)}</section>
    <button class="resize-handle" data-resize-handle type="button" aria-label="Redimensionar"></button>
  `;
}

function widgetContent(widget) {
  if (widget.spec?.runtime) return renderLiveWidget(widget);
  if (widget.type === "chat") return `
    <div class="transcript" data-role="transcript" aria-live="polite"></div>
    <form class="composer" data-role="chat-form">
      <input data-role="prompt" autocomplete="off" placeholder="Pregunta, orden o llamada JSON">
      <button class="send-button" type="submit">SEND</button>
    </form>
    <div class="voice-row">
      <label class="voice-toggle"><input data-role="voice" type="checkbox"><span>Voz grave</span></label>
      <button class="mini-button" data-action="listen" type="button">MIC</button>
      <button class="mini-button" data-action="repeat" type="button">RPT</button>
      <button class="mini-button danger" data-action="stop" type="button">STOP</button>
      <button class="mini-button" data-action="clear" type="button">CLR</button>
    </div>`;
  if (widget.type === "metrics") return `
    <div class="metric-grid">
      <article class="metric"><span>CPU</span><strong data-role="cpu">--</strong><small data-role="temp">Temp --</small></article>
      <article class="metric"><span>RAM</span><strong data-role="ram">--</strong><small>Presion de memoria</small></article>
      <article class="metric"><span>Disco</span><strong data-role="disk">--</strong><small>Volumen raiz</small></article>
      <article class="metric"><span>Perimetro</span><strong data-role="threat">--</strong><small data-role="threat-detail">Sin escaneo</small></article>
    </div>
    <div class="list" data-role="containers"></div>`;
  if (widget.type === "config") return `
    <div class="stack">
      <section class="holo-block">
        <h3>OpenAI Codex</h3>
        <button class="primary-button" data-action="codex-login" type="button">Iniciar sesion con OpenAI</button>
        <div class="login-code" data-role="codex-box" hidden>
          <a data-role="codex-url" href="#" target="_blank" rel="noopener">Abrir login</a>
          <strong data-role="codex-code">----</strong>
          <span data-role="codex-status">Esperando autorizacion.</span>
        </div>
      </section>
      <section class="holo-block">
        <h3>Google Gemini Fallback</h3>
        <form class="settings-form" data-role="google-form">
          <input data-role="google-key" type="password" autocomplete="off" placeholder="GOOGLE_API_KEY">
          <input data-role="google-model" autocomplete="off" placeholder="gemini-2.5-flash-lite">
          <button class="mini-button" type="submit">Guardar</button>
        </form>
        <button class="mini-button wide" data-action="test-google" type="button">Probar Gemini</button>
      </section>
      <section class="holo-block">
        <h3>Google OAuth2</h3>
        <p class="muted" data-role="google-oauth-status">Consultando estado.</p>
        <a class="primary-link" href="/oauth/google/start" target="_blank" rel="noopener">Conectar Google OAuth</a>
      </section>
      <pre class="output" data-role="brain-output"></pre>
    </div>`;
  if (widget.type === "logs") return `
    <div class="section-head"><h3>Memoria Operativa</h3><button class="mini-button" data-action="reload-incidents" type="button">Revisar</button></div>
    <div class="list" data-role="incidents"></div>
    <div class="section-head"><h3>Capacidades</h3></div>
    <div class="list" data-role="capabilities"></div>`;
  if (widget.type === "assets") return `
    <div class="section-head"><h3>Assets Conectados</h3><button class="mini-button" data-action="load-bridge" type="button">Puente</button></div>
    <div class="list" data-role="assets"></div>
    <div class="control-grid">
      <input data-role="asset-id" value="main-pc" aria-label="Asset id">
      <select data-role="asset-action" aria-label="Accion">
        <option value="ping">Ping</option><option value="process_audit">Auditar procesos</option><option value="launch">Abrir app</option><option value="lock">Bloquear</option><option value="sleep">Suspender</option>
      </select>
      <input data-role="asset-app" placeholder="Clave de app">
      <button class="mini-button" data-action="asset-command" type="button">Ejecutar</button>
    </div>
    <pre class="output" data-role="asset-output"></pre>`;
  if (widget.type === "self") return `
    <div class="dynamic-widget">
      <p class="muted">${escapeHtml(widget.spec.description || "Control operativo de JARVIS")}</p>
      <div class="control-grid">
        <button class="mini-button" data-action="self-status" type="button">Estado propio</button>
        <button class="mini-button danger" data-action="self-restart" type="button">Reiniciar JARVIS</button>
      </div>
      <pre class="output" data-role="self-output"></pre>
    </div>`;
  if (widget.type === "terminal") return `
    <div class="dynamic-widget">
      <p class="muted">${escapeHtml(widget.spec.description || "Comandos confirmados en el host Umbrel")}</p>
      <form class="composer" data-role="terminal-form">
        <input data-role="terminal-command" autocomplete="off" placeholder="Comando host confirmado">
        <button class="send-button" type="submit">RUN</button>
      </form>
      <pre class="output" data-role="terminal-output"></pre>
    </div>`;
  return `
    <div class="dynamic-widget">
      ${renderGeneratedWidget(widget)}
    </div>`;
}

function renderLiveWidget(widget) {
  return `<iframe class="live-frame" data-role="live-frame" sandbox="allow-scripts allow-forms allow-popups allow-modals" title="${escapeHtml(widget.title)}"></iframe>`;
}

function renderGeneratedWidget(widget) {
  const custom = widget.spec.custom || {};
  const fields = Array.isArray(custom.fields) ? custom.fields : [];
  const actions = Array.isArray(custom.actions) ? custom.actions : [];
  const notes = Array.isArray(custom.notes) ? custom.notes : [];
  return `
    <p class="muted">${escapeHtml(widget.spec.description || "Widget generado por JARVIS")}</p>
    <form class="generated-form" data-role="generated-form">
      ${fields.map(renderGeneratedField).join("") || `<div class="generated-note">Sin campos. Usa acciones directas.</div>`}
      <div class="generated-actions">
        ${actions.map((action) => `<button class="mini-button" data-generated-action="${escapeHtml(action.id)}" type="button">${escapeHtml(action.label || action.id)}</button>`).join("") || `<button class="mini-button" data-generated-action="show" type="button">Mostrar</button>`}
      </div>
    </form>
    ${notes.length ? `<div class="telemetry-lines">${notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>` : ""}
    <pre class="output generated-output" data-role="generated-output"></pre>`;
}

function renderGeneratedField(field) {
  const id = escapeHtml(field.id || "value");
  const label = escapeHtml(field.label || field.id || "Valor");
  const placeholder = escapeHtml(field.placeholder || "");
  if (field.type === "textarea") {
    return `<label class="generated-field"><span>${label}</span><textarea data-generated-field="${id}" placeholder="${placeholder}"></textarea></label>`;
  }
  if (field.type === "select") {
    const options = Array.isArray(field.options) ? field.options : [];
    return `<label class="generated-field"><span>${label}</span><select data-generated-field="${id}">${options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("")}</select></label>`;
  }
  const type = ["search", "number", "text"].includes(field.type) ? field.type : "text";
  return `<label class="generated-field"><span>${label}</span><input data-generated-field="${id}" type="${type}" placeholder="${placeholder}" autocomplete="off"></label>`;
}

function bindWidget(widget) {
  const element = widget.element;
  element.querySelector("[data-drag-handle]").addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, a, input, select, textarea, label")) return;
    state.drag = { id: widget.id, mode: "move", x: event.clientX, y: event.clientY, ox: widget.x, oy: widget.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  element.querySelector("[data-resize-handle]").addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    state.drag = { id: widget.id, mode: "resize", x: event.clientX, y: event.clientY, ow: widget.w, oh: widget.h };
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  element.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    handleWidgetAction(widget, action);
  });
  const chatForm = element.querySelector("[data-role='chat-form']");
  if (chatForm) {
    chatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = element.querySelector("[data-role='prompt']");
      const message = input.value.trim();
      if (!message) return;
      input.value = "";
      sendChatFromWidget(widget, message);
    });
  }
  const googleForm = element.querySelector("[data-role='google-form']");
  if (googleForm) googleForm.addEventListener("submit", (event) => saveGoogleSettings(event, widget));
  const terminalForm = element.querySelector("[data-role='terminal-form']");
  if (terminalForm) terminalForm.addEventListener("submit", (event) => runTerminalCommand(event, widget));
  const generatedForm = element.querySelector("[data-role='generated-form']");
  if (generatedForm) {
    generatedForm.addEventListener("submit", (event) => {
      event.preventDefault();
      runGeneratedAction(widget, widget.spec.custom?.actions?.[0]?.id || "show");
    });
    generatedForm.addEventListener("click", (event) => {
      const actionId = event.target.closest("[data-generated-action]")?.dataset.generatedAction;
      if (!actionId) return;
      event.preventDefault();
      runGeneratedAction(widget, actionId);
    });
  }
  const liveFrame = element.querySelector("[data-role='live-frame']");
  if (liveFrame) mountLiveWidget(widget, liveFrame);
}

async function handleWidgetAction(widget, action) {
  if (action === "close") return closeWidget(widget);
  if (action === "refresh") return loadWidgetData(widget);
  if (action === "listen") return toggleDictation(widget);
  if (action === "repeat") return speak(widget, state.lastAssistantText, true);
  if (action === "stop") return stopVoice();
  if (action === "clear") {
    stopVoice();
    const transcript = widget.element.querySelector("[data-role='transcript']");
    if (transcript) transcript.innerHTML = "";
    return;
  }
  if (action === "codex-login") return startCodexLogin(widget);
  if (action === "test-google") return testGoogleSettings(widget);
  if (action === "reload-incidents") return loadStatus();
  if (action === "load-bridge") return loadBridgeConfig(widget);
  if (action === "asset-command") return sendAssetCommand(widget);
  if (action === "self-status") return loadSelfStatus(widget);
  if (action === "self-restart") return restartSelf(widget);
}

function closeWidget(widget) {
  widget.element.remove();
  state.widgets = state.widgets.filter((item) => item.id !== widget.id);
  if (widget.savedId) {
    fetch(`/widgets/${encodeURIComponent(widget.savedId)}`, { method: "DELETE" }).catch(() => {});
  }
}

function focusOrCreate(type) {
  const widget = state.widgets.find((item) => item.type === type) || addWidget(type);
  focusWidget(widget);
}

function focusWidget(widget) {
  widget.element.classList.add("focused");
  setTimeout(() => widget.element.classList.remove("focused"), 850);
  state.targetView.x = $("canvasViewport").clientWidth / 2 - (widget.x + widget.w / 2) * state.targetView.scale;
  state.targetView.y = $("canvasViewport").clientHeight / 2 - (widget.y + widget.h / 2) * state.targetView.scale;
  animateView();
  const input = widget.element.querySelector("[data-role='prompt']");
  if (input) setTimeout(() => input.focus(), 180);
}

function pulseCore() {
  $("arcApp").classList.add("core-fired");
  setTimeout(() => $("arcApp").classList.remove("core-fired"), 900);
}

async function sendChatFromWidget(widget, message) {
  appendMessage(widget, "user", message);
  const assistant = appendMessage(widget, "assistant", "Pensando.");
  try {
    assistant.textContent = "";
    let streamed = false;
    if ("EventSource" in window) {
      streamed = await streamWithSse(message, (chunk) => {
        assistant.textContent += chunk;
        scrollTranscript(widget);
      });
    }
    if (!streamed) {
      await streamWithFetch(message, (chunk) => {
        assistant.textContent += chunk;
        scrollTranscript(widget);
      });
    }
    state.lastAssistantText = cleanAssistantText(assistant.textContent);
    assistant.textContent = state.lastAssistantText || "Sin respuesta.";
    speak(widget, state.lastAssistantText, false);
  } catch (error) {
    assistant.textContent = `Fallo de enlace: ${error.message}`;
  }
}

function streamWithSse(message, onChunk) {
  return new Promise((resolve) => {
    const source = new EventSource(`/chat/stream?message=${encodeURIComponent(message)}`);
    let received = false;
    source.onmessage = (event) => {
      received = true;
      const data = JSON.parse(event.data);
      onChunk(data.chunk || "");
    };
    source.addEventListener("done", () => {
      source.close();
      resolve(received);
    });
    source.onerror = () => {
      source.close();
      resolve(received);
    };
  });
}

async function streamWithFetch(message, onChunk) {
  const response = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

function appendMessage(widget, role, content) {
  const transcript = widget.element.querySelector("[data-role='transcript']");
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = content;
  transcript.appendChild(node);
  scrollTranscript(widget);
  return node;
}

function scrollTranscript(widget) {
  const transcript = widget.element.querySelector("[data-role='transcript']");
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

async function refreshAll() {
  await Promise.allSettled([loadStatus(), loadAssets(), loadGoogleOAuthStatus()]);
}

async function loadGeneratedWidgets() {
  try {
    const data = await getJson("/widgets");
    const widgets = Array.isArray(data.widgets) ? data.widgets : [];
    widgets.forEach((spec, index) => {
      if (!spec?.id || state.widgets.some((widget) => widget.savedId === spec.id)) return;
      addWidget(spec.type || "live", {
        spec,
        title: spec.title,
        savedId: spec.id,
        x: 120 + index * 28,
        y: 120 + index * 28,
        w: spec.size?.w,
        h: spec.size?.h
      });
    });
  } catch {
    // Generated widgets are optional; the dashboard stays usable without them.
  }
}

async function loadWidgetData(widget) {
  if (widget.type === "metrics" || widget.type === "logs" || widget.type === "config") await loadStatus();
  if (widget.type === "assets") await loadAssets();
  if (widget.type === "config") await loadGoogleOAuthStatus();
}

async function loadStatus() {
  const data = await getJson("/status");
  const context = data.context || {};
  const vitals = context.vitals || {};
  const threats = context.threats || {};
  const docker = context.docker || {};
  const primary = data.brain?.primary || {};
  const fallback = data.brain?.fallback || {};
  $("brainState").textContent = primary.state === "ready" ? "CODEX ONLINE" : fallback.state === "ready" ? "GEMINI ONLINE" : "AUTH REQUIRED";

  state.widgets.filter((widget) => widget.type === "metrics").forEach((widget) => {
    setText(widget, "cpu", percent(vitals.cpu_percent));
    setText(widget, "ram", percent(vitals.ram_percent));
    setText(widget, "disk", percent(vitals.disk_percent));
    setText(widget, "temp", vitals.cpu_temperature_c === null ? "Temp no disponible" : `${Number(vitals.cpu_temperature_c).toFixed(1)} C`);
    setText(widget, "threat", threats.status || "--");
    setText(widget, "threat-detail", threats.summary || "Sin escaneo");
    const containers = widget.element.querySelector("[data-role='containers']");
    if (containers) containers.innerHTML = renderContainers(docker);
  });

  state.widgets.filter((widget) => widget.type === "logs").forEach((widget) => {
    const incidents = widget.element.querySelector("[data-role='incidents']");
    const capabilities = widget.element.querySelector("[data-role='capabilities']");
    if (incidents) incidents.innerHTML = (context.recent_incidents || []).map((item) => row(item.summary, `${item.category} - ${item.created_at}`, "warning")).join("") || row("Sin incidentes", "Memoria limpia", "");
    if (capabilities) capabilities.innerHTML = (data.capabilities || []).map((item) => row(item.name, JSON.stringify(item.arguments), "")).join("");
  });

  state.widgets.filter((widget) => widget.type === "config").forEach((widget) => {
    setRoleText(widget, "brain-output", JSON.stringify(data.brain, null, 2));
  });
}

async function saveGoogleSettings(event, widget) {
  event.preventDefault();
  const apiKey = widget.element.querySelector("[data-role='google-key']").value.trim();
  const model = widget.element.querySelector("[data-role='google-model']").value.trim();
  if (!apiKey) return setRoleText(widget, "brain-output", "Introduce una GOOGLE_API_KEY.");
  setRoleText(widget, "brain-output", "Guardando fallback Google.");
  try {
    const data = await getJson("/settings/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, model: model || null })
    });
    widget.element.querySelector("[data-role='google-key']").value = "";
    setRoleText(widget, "brain-output", JSON.stringify(data.brain, null, 2));
    await testGoogleSettings(widget);
  } catch (error) {
    setRoleText(widget, "brain-output", error.message);
  }
}

async function testGoogleSettings(widget) {
  setRoleText(widget, "brain-output", "Probando Google Gemini.");
  try {
    const data = await getJson("/settings/google/test", { method: "POST", headers: { "Content-Type": "application/json" } });
    setRoleText(widget, "brain-output", `${data.ok ? "Google Gemini operativo." : "Google Gemini no respondio."}\n\n${data.response}`);
    await loadStatus();
  } catch (error) {
    setRoleText(widget, "brain-output", error.message);
  }
}

async function loadGoogleOAuthStatus() {
  try {
    const data = await getJson("/settings/google/oauth/status");
    state.widgets.filter((widget) => widget.type === "config").forEach((widget) => {
      setRoleText(widget, "google-oauth-status", `${data.connected ? "Conectado" : "Sin conectar"} - ${data.detail} Redirect: ${data.redirect_uri}`);
    });
  } catch {
    state.widgets.filter((widget) => widget.type === "config").forEach((widget) => setRoleText(widget, "google-oauth-status", "OAuth no disponible."));
  }
}

async function startCodexLogin(widget) {
  const box = widget.element.querySelector("[data-role='codex-box']");
  box.hidden = false;
  setRoleText(widget, "codex-status", "Generando codigo de OpenAI.");
  try {
    const data = await getJson("/settings/codex-login/start", { method: "POST", headers: { "Content-Type": "application/json" } });
    renderCodexLogin(widget, data.login);
    if (state.codexLoginTimer) clearInterval(state.codexLoginTimer);
    if (data.login.state !== "connected") state.codexLoginTimer = setInterval(() => pollCodexLogin(widget), 3000);
  } catch (error) {
    setRoleText(widget, "codex-status", error.message);
  }
}

async function pollCodexLogin(widget) {
  try {
    const data = await getJson("/settings/codex-login/status");
    renderCodexLogin(widget, data.login);
    if (["connected", "failed", "expired"].includes(data.login.state)) {
      clearInterval(state.codexLoginTimer);
      state.codexLoginTimer = null;
      await loadStatus();
    }
  } catch (error) {
    setRoleText(widget, "codex-status", error.message);
  }
}

function renderCodexLogin(widget, login) {
  const box = widget.element.querySelector("[data-role='codex-box']");
  box.hidden = false;
  const url = widget.element.querySelector("[data-role='codex-url']");
  if (login.url) {
    url.href = login.url;
    url.textContent = login.url;
  }
  if (login.code) setRoleText(widget, "codex-code", login.code);
  const labels = {
    waiting_for_browser: "Abre OpenAI, introduce el codigo y autoriza Codex.",
    connected: "Codex conectado con tu cuenta de OpenAI.",
    failed: login.detail || "No se pudo completar el login.",
    expired: login.detail || "El codigo ha caducado.",
    idle: "Sin login activo."
  };
  setRoleText(widget, "codex-status", labels[login.state] || login.state || "Esperando.");
}

async function loadAssets() {
  const data = await getJson("/assets");
  state.widgets.filter((widget) => widget.type === "assets").forEach((widget) => {
    const target = widget.element.querySelector("[data-role='assets']");
    target.innerHTML = data.map((item) => row(item.asset_id, `Conectado ${item.connected_at}`, "")).join("") || row("Sin assets", "Arranca el puente remoto", "warning");
  });
}

async function loadBridgeConfig(widget) {
  const data = await getJson("/asset-bridge/config");
  const origin = window.location.origin.replace(/^http/, "ws");
  setRoleText(widget, "asset-output", `python asset_bridge.py --server ${origin}${data.websocket_path} --asset-id ${data.asset_id} --key "${data.bridge_key}"`);
}

async function sendAssetCommand(widget) {
  const assetId = widget.element.querySelector("[data-role='asset-id']").value.trim();
  const action = widget.element.querySelector("[data-role='asset-action']").value;
  const app = widget.element.querySelector("[data-role='asset-app']").value.trim();
  const payload = action === "launch" ? { app } : {};
  setRoleText(widget, "asset-output", "Enviando.");
  try {
    const data = await getJson(`/assets/${encodeURIComponent(assetId)}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload })
    });
    setRoleText(widget, "asset-output", JSON.stringify(data, null, 2));
    await loadAssets();
  } catch (error) {
    setRoleText(widget, "asset-output", error.message);
  }
}

async function loadSelfStatus(widget) {
  setRoleText(widget, "self-output", "Consultando estado propio.");
  const data = await getJson("/tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "jarvis.self_status", arguments: {} })
  });
  setRoleText(widget, "self-output", JSON.stringify(data.result, null, 2));
}

async function restartSelf(widget) {
  setRoleText(widget, "self-output", "Reiniciando JARVIS.");
  const data = await getJson("/tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "jarvis.self_restart", arguments: { confirm: true } })
  });
  setRoleText(widget, "self-output", JSON.stringify(data.result, null, 2));
}

async function runTerminalCommand(event, widget) {
  event.preventDefault();
  const input = widget.element.querySelector("[data-role='terminal-command']");
  const command = input.value.trim();
  if (!command) return;
  setRoleText(widget, "terminal-output", "Ejecutando en host.");
  const data = await getJson("/tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "system.host_shell", arguments: { command, confirm: true, timeout: 60 } })
  });
  setRoleText(widget, "terminal-output", JSON.stringify(data.result, null, 2));
}

function mountLiveWidget(widget, frame) {
  const runtime = widget.spec.runtime || {};
  const bridge = runtimeBridgeScript(widget.id);
  frame.srcdoc = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: dark; font-family: "Share Tech Mono", "JetBrains Mono", Consolas, monospace; }
    * { box-sizing: border-box; }
    html, body { width: 100%; min-height: 100%; margin: 0; background: transparent; color: #e8fcff; overflow: auto; }
    body { padding: 2px; }
    ${runtime.css || ""}
  </style>
</head>
<body>
  ${runtime.html || "<div>Widget vivo sin interfaz.</div>"}
  <script>${bridge}<\/script>
  <script>
  try {
    ${runtime.js || ""}
  } catch (error) {
    JARVIS.toast("Error runtime: " + error.message);
  }
  <\/script>
</body>
</html>`;
}

function runtimeBridgeScript(widgetId) {
  return `
window.JARVIS = (() => {
  let seq = 0;
  const pending = new Map();
  window.addEventListener("message", (event) => {
    const data = event.data || {};
    if (!data.jarvisRuntimeResponse || data.widgetId !== ${JSON.stringify(widgetId)}) return;
    const resolver = pending.get(data.requestId);
    if (!resolver) return;
    pending.delete(data.requestId);
    if (data.ok) resolver.resolve(data.payload);
    else resolver.reject(new Error(data.error || "JARVIS bridge error"));
  });
  function request(type, payload) {
    const requestId = "r" + (++seq);
    parent.postMessage({ jarvisRuntime: true, widgetId: ${JSON.stringify(widgetId)}, requestId, type, payload }, "*");
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error("Tiempo agotado esperando a JARVIS."));
      }, 60000);
    });
  }
  return {
    callTool: (tool, argumentsObject = {}) => request("tool", { tool, arguments: argumentsObject }),
    chat: (message) => request("chat", { message }),
    status: () => request("status", {}),
    openUrl: (url) => request("openUrl", { url }),
    toast: (text) => request("toast", { text })
  };
})();`;
}

async function handleRuntimeMessage(event) {
  const data = event.data || {};
  if (!data.jarvisRuntime) return;
  const widget = state.widgets.find((item) => item.id === data.widgetId);
  if (!widget) return;
  try {
    let payload = {};
    if (data.type === "tool") {
      payload = await getJson("/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: data.payload?.tool, arguments: data.payload?.arguments || {} })
      });
    } else if (data.type === "chat") {
      payload = { text: await chatText(data.payload?.message || "") };
    } else if (data.type === "status") {
      payload = await getJson("/status");
    } else if (data.type === "openUrl") {
      const url = String(data.payload?.url || "");
      if (!/^https?:\/\//i.test(url)) throw new Error("URL bloqueada: usa http/https.");
      window.open(url, "_blank", "noopener,noreferrer");
      payload = { opened: true, url };
    } else if (data.type === "toast") {
      toast(String(data.payload?.text || ""));
      payload = { ok: true };
    } else {
      throw new Error(`Operacion no soportada: ${data.type}`);
    }
    event.source?.postMessage({ jarvisRuntimeResponse: true, widgetId: data.widgetId, requestId: data.requestId, ok: true, payload }, "*");
  } catch (error) {
    event.source?.postMessage({ jarvisRuntimeResponse: true, widgetId: data.widgetId, requestId: data.requestId, ok: false, error: error.message }, "*");
  }
}

async function chatText(message) {
  const response = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return cleanAssistantText(await response.text());
}

async function runGeneratedAction(widget, actionId) {
  const custom = widget.spec.custom || {};
  const actions = Array.isArray(custom.actions) ? custom.actions : [];
  const action = actions.find((item) => item.id === actionId) || { id: "show", label: "Mostrar", type: "show_value" };
  const values = generatedValues(widget);
  const output = widget.element.querySelector("[data-role='generated-output']");
  if (output) output.textContent = "Ejecutando.";
  try {
    if (action.type === "open_url") {
      const url = fillTemplate(action.urlTemplate || "https://www.google.com/search?q={query}", values);
      if (!/^https?:\/\//i.test(url)) throw new Error("La accion open_url requiere una URL http/https.");
      window.open(url, "_blank", "noopener,noreferrer");
      if (output) output.textContent = `Abierto: ${url}`;
      return;
    }
    if (action.type === "ask_jarvis") {
      const message = fillTemplate(action.promptTemplate || widget.spec.query || "{request}", values);
      if (output) output.textContent = "Enviado a JARVIS.";
      const chat = state.widgets.find((item) => item.type === "chat") || addWidget("chat");
      focusWidget(chat);
      await sendChatFromWidget(chat, message);
      return;
    }
    if (action.type === "tool_call") {
      const data = await getJson("/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: action.tool, arguments: fillObjectTemplates(action.arguments || {}, values) })
      });
      if (output) output.textContent = JSON.stringify(data.result || data, null, 2);
      return;
    }
    if (output) output.textContent = JSON.stringify(values, null, 2);
  } catch (error) {
    if (output) output.textContent = `Fallo: ${error.message}`;
  }
}

function generatedValues(widget) {
  const values = {};
  widget.element.querySelectorAll("[data-generated-field]").forEach((field) => {
    values[field.dataset.generatedField] = field.value;
  });
  if (!("query" in values)) {
    const first = Object.values(values).find((value) => String(value || "").trim());
    if (first) values.query = first;
  }
  return values;
}

function fillTemplate(template, values) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => encodeURIComponent(values[key] ?? ""));
}

function fillObjectTemplates(value, values) {
  if (typeof value === "string") return fillTemplate(value, values);
  if (Array.isArray(value)) return value.map((item) => fillObjectTemplates(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillObjectTemplates(item, values)]));
  }
  return value;
}

function toggleDictation(widget) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return appendMessage(widget, "assistant", "Dictado no disponible en este navegador.");
  if (state.listening && state.recognition) {
    state.continuousListening = false;
    state.recognition.stop();
    return;
  }
  state.continuousListening = true;
  state.activeVoiceWidget = widget;
  const recognition = new SpeechRecognition();
  recognition.lang = "es-ES";
  recognition.interimResults = false;
  recognition.continuous = true;
  recognition.onstart = () => {
    state.listening = true;
    widget.element.classList.add("recording");
  };
  recognition.onend = () => {
    state.listening = false;
    widget.element.classList.remove("recording");
    if (state.continuousListening && state.activeVoiceWidget === widget) {
      setTimeout(() => {
        try {
          recognition.start();
        } catch {}
      }, 350);
    }
  };
  recognition.onresult = (event) => sendChatFromWidget(widget, event.results[0][0].transcript);
  state.recognition = recognition;
  recognition.start();
}

function speak(widget, text, force) {
  const cleanText = cleanAssistantText(text);
  const enabled = widget?.element?.querySelector("[data-role='voice']")?.checked;
  if (!cleanText || !("speechSynthesis" in window)) return;
  if (!force && !enabled) return;
  stopVoice();
  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.lang = /[áéíóúñ¿¡]/i.test(cleanText) ? "es-ES" : "en-GB";
  utterance.rate = 0.82;
  utterance.pitch = 0.45;
  const voices = state.voices.length ? state.voices : window.speechSynthesis.getVoices();
  const preferredNames = ["pablo", "jorge", "alvaro", "álvaro", "diego", "microsoft pablo", "microsoft alvaro", "google uk english male", "microsoft george", "microsoft david", "daniel", "thomas", "alex"];
  const preferred = voices.find((voice) => preferredNames.some((name) => voice.name.toLowerCase().includes(name)))
    || voices.find((voice) => voice.lang === utterance.lang)
    || voices.find((voice) => voice.lang.startsWith(utterance.lang.slice(0, 2)));
  if (preferred) utterance.voice = preferred;
  window.speechSynthesis.speak(utterance);
}

function stopVoice() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  state.continuousListening = false;
  if (state.recognition && state.listening) state.recognition.stop();
}

function loadVoices() {
  if ("speechSynthesis" in window) state.voices = window.speechSynthesis.getVoices();
}

function scheduleWorldTransform() {
  if (state.raf) return;
  state.raf = requestAnimationFrame(() => {
    state.raf = 0;
    $("canvasWorld").style.transform = `translate3d(${state.view.x}px, ${state.view.y}px, 0) scale(${state.view.scale})`;
  });
}

function animateView() {
  if (state.viewRaf) return;
  const tick = () => {
    state.view.x += (state.targetView.x - state.view.x) * 0.28;
    state.view.y += (state.targetView.y - state.view.y) * 0.28;
    state.view.scale += (state.targetView.scale - state.view.scale) * 0.22;
    scheduleWorldTransform();
    const settled = Math.abs(state.targetView.x - state.view.x) < 0.2
      && Math.abs(state.targetView.y - state.view.y) < 0.2
      && Math.abs(state.targetView.scale - state.view.scale) < 0.002;
    if (settled) {
      state.view = { ...state.targetView };
      scheduleWorldTransform();
      state.viewRaf = 0;
      return;
    }
    state.viewRaf = requestAnimationFrame(tick);
  };
  state.viewRaf = requestAnimationFrame(tick);
}

function zoomAt(clientX, clientY, factor) {
  const before = screenToWorld(clientX, clientY);
  state.targetView.scale = clamp(state.targetView.scale * factor, 0.42, 1.7);
  const rect = $("canvasViewport").getBoundingClientRect();
  state.targetView.x = clientX - rect.left - before.x * state.targetView.scale;
  state.targetView.y = clientY - rect.top - before.y * state.targetView.scale;
  animateView();
}

function trackTouchPointer(event) {
  if (!state.pinch) state.pinch = { points: new Map(), startDistance: 0, startScale: state.targetView.scale };
  state.pinch.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
  $("canvasViewport").setPointerCapture(event.pointerId);
  if (state.pinch.points.size === 1) {
    state.pan = { x: event.clientX, y: event.clientY, ox: state.targetView.x, oy: state.targetView.y };
  }
  if (state.pinch.points.size === 2) {
    const points = [...state.pinch.points.values()];
    state.pinch.startDistance = distance(points[0], points[1]);
    state.pinch.startScale = state.targetView.scale;
    state.pan = null;
  }
}

function updatePinch() {
  const points = [...state.pinch.points.values()];
  if (points.length < 2) return;
  const current = distance(points[0], points[1]);
  const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  zoomAt(center.x, center.y, current / Math.max(state.pinch.startDistance, 1));
  state.pinch.startDistance = current;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function scheduleWidgetTransform(widget) {
  if (widget.framePending) return;
  widget.framePending = true;
  requestAnimationFrame(() => {
    widget.framePending = false;
    widget.element.style.width = `${widget.w}px`;
    widget.element.style.height = `${widget.h}px`;
    widget.element.style.transform = `translate3d(${widget.x}px, ${widget.y}px, 0)`;
  });
}

function screenToWorld(x, y) {
  const rect = $("canvasViewport").getBoundingClientRect();
  return {
    x: (x - rect.left - state.view.x) / state.view.scale,
    y: (y - rect.top - state.view.y) / state.view.scale
  };
}

function worldToScreen(x, y) {
  const rect = $("canvasViewport").getBoundingClientRect();
  return {
    x: rect.left + state.view.x + x * state.view.scale,
    y: rect.top + state.view.y + y * state.view.scale
  };
}

function inferWidgetType(prompt) {
  const text = prompt.toLowerCase();
  if (/(control|reinicia|actualiza|self|propio|ti mismo)/.test(text)) return "self";
  if (/(comando|terminal|shell|sistema|host)/.test(text)) return "terminal";
  if (/(chat|habla|pregunta|asistente|jarvis)/.test(text)) return "chat";
  if (/(google|oauth|openai|codex|gemini|api|config)/.test(text)) return "config";
  if (/(log|incidente|memoria|evento)/.test(text)) return "logs";
  if (/(asset|remoto|pc|almacenamiento|storage|disco remoto)/.test(text)) return "assets";
  if (/(cpu|ram|docker|red|network|trafico|trÃ¡fico|metrica|mÃ©trica)/.test(text)) return "metrics";
  return "custom";
}

function titleFromPrompt(prompt, type) {
  if (type !== "custom") return widgetDefaults[type].title;
  const clean = prompt.replace(/[^\w\sÃ¡Ã©Ã­Ã³ÃºÃ±]/gi, "").trim();
  return clean ? clean.slice(0, 34) : "Dynamic Widget";
}

function renderContainers(data) {
  if (!data.available) return row("Docker no disponible", data.error || "Socket no montado", "warning");
  return data.containers.slice(0, 8).map((item) => row(item.name, `${item.status} - ${item.image}`, item.status === "running" ? "" : "warning")).join("") || row("Sin contenedores", "Registro vacio", "warning");
}

function setText(widget, role, text) {
  const node = widget.element.querySelector(`[data-role='${role}']`);
  if (node) node.textContent = text;
}

function setRoleText(widget, role, text) {
  setText(widget, role, text);
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

function cleanAssistantText(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !isTerminalNoise(line)).join("\n").trim();
}

function isTerminalNoise(line) {
  const lower = line.toLowerCase();
  if ([">", "$", "â¯"].includes(line)) return true;
  if (/^[-_|+=~: .[\]()0-9]{12,}$/.test(line)) return true;
  return ["msg=interrupt", "/queue", "/bg", "/steer", "ctrl+c", "tokens", "private telemetry", "current local telemetry", "codex exec"].some((fragment) => lower.includes(fragment));
}

function percent(value) {
  return typeof value === "number" ? `${value.toFixed(0)}%` : "--";
}

function row(title, detail, tone) {
  return `<div class="row ${tone || ""}"><div><strong>${escapeHtml(title)}</strong><br><small>${escapeHtml(detail)}</small></div><span></span></div>`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  setTimeout(() => $("toast").classList.remove("visible"), 2600);
}

