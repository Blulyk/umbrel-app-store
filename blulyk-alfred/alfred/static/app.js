const state = {
  lastAssistantText: "",
  recognition: null,
  listening: false,
  codexLoginTimer: null
};

const $ = (id) => document.getElementById(id);

document.querySelectorAll(".rail-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".rail-button").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((view) => view.classList.remove("active-view"));
    button.classList.add("active");
    $(button.dataset.section).classList.add("active-view");
  });
});

$("refreshAll").addEventListener("click", refreshAll);
$("reloadDocker").addEventListener("click", loadDocker);
$("reloadIncidents").addEventListener("click", loadStatus);
$("reloadAssets").addEventListener("click", loadAssets);
$("reloadCapabilities").addEventListener("click", loadStatus);
$("reloadBrain").addEventListener("click", loadStatus);
$("loadBridge").addEventListener("click", loadBridgeConfig);
$("sendAssetCommand").addEventListener("click", sendAssetCommand);
$("googleForm").addEventListener("submit", saveGoogleSettings);
$("testGoogle").addEventListener("click", testGoogleSettings);
$("codexAuthForm").addEventListener("submit", importCodexAuth);
$("startCodexLogin").addEventListener("click", startCodexLogin);
$("openSystemsFromCore").addEventListener("click", () => document.querySelector('[data-section="systems"]').click());
$("repeatVoice").addEventListener("click", () => speak(state.lastAssistantText, true));
$("stopVoice").addEventListener("click", stopVoice);
$("listenVoice").addEventListener("click", toggleDictation);
$("clearConsole").addEventListener("click", () => {
  stopVoice();
  $("transcript").innerHTML = "";
  state.lastAssistantText = "";
});
$("voiceToggle").addEventListener("change", () => {
  if (!$("voiceToggle").checked) stopVoice();
});

$("quickForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = $("quickInput").value.trim();
  if (!value) return;
  $("quickInput").value = "";
  await sendChat(value);
  document.querySelector('[data-section="console"]').click();
});

$("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("promptInput");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  await sendChat(message);
});

async function sendChat(message) {
  appendMessage("user", message);
  const assistant = appendMessage("assistant", "Pensando.");
  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    assistant.textContent = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      assistant.textContent += decoder.decode(value, { stream: true });
      scrollTranscript();
    }
    state.lastAssistantText = cleanAssistantText(assistant.textContent);
    assistant.textContent = state.lastAssistantText || "Sin respuesta.";
    if ($("voiceToggle").checked) speak(state.lastAssistantText, false);
  } catch (error) {
    assistant.textContent = `Fallo de enlace: ${error.message}`;
  }
}

async function refreshAll() {
  await Promise.allSettled([loadStatus(), loadAssets()]);
}

async function loadStatus() {
  const data = await getJson("/status");
  const context = data.context;
  const vitals = context.vitals;
  const threats = context.threats;
  const docker = context.docker;
  const brain = data.brain;

  const primary = brain.primary || {};
  const fallback = brain.fallback || {};
  const primaryReady = primary.state === "ready";
  const fallbackReady = fallback.state === "ready";

  $("brainState").textContent = primaryReady ? "Codex listo" : fallbackReady ? "Google listo" : "Configurar Codex";
  $("briefingTitle").textContent = vitals.status === "Nominal" ? "Sistemas nominales." : vitals.status;
  $("briefingText").textContent = `Codex: ${primary.state || "needs_auth"}. Google: ${fallback.state || "needs_key"}. ${vitals.notes.join(" ")}`;
  $("brainName").textContent = `${primary.provider || "codex-chatgpt-oauth"} / ${primary.model || "codex"}`;
  $("brainDetail").textContent = `${primary.detail || ""} ${fallback.detail || ""}`.trim();
  $("cpuMetric").textContent = percent(vitals.cpu_percent);
  $("ramMetric").textContent = percent(vitals.ram_percent);
  $("diskMetric").textContent = percent(vitals.disk_percent);
  $("tempMetric").textContent = vitals.cpu_temperature_c === null ? "Temperatura no disponible" : `${vitals.cpu_temperature_c.toFixed(1)}C`;
  $("threatMetric").textContent = threats.status;
  $("threatSummary").textContent = threats.anomalies.length ? `${threats.anomalies.length} eventos` : threats.summary;

  renderContainers(docker);
  renderIncidents(context.recent_incidents);
  $("capabilityList").innerHTML = data.capabilities.map((item) => row(item.name, JSON.stringify(item.arguments), "")).join("");
  $("brainOutput").textContent = JSON.stringify(brain, null, 2);
}

async function saveGoogleSettings(event) {
  event.preventDefault();
  const apiKey = $("googleKey").value.trim();
  const model = $("googleModel").value.trim();
  if (!apiKey) {
    $("brainOutput").textContent = "Introduce una GOOGLE_API_KEY.";
    return;
  }
  $("brainOutput").textContent = "Guardando fallback Google.";
  try {
    const data = await getJson("/settings/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, model: model || null })
    });
    $("googleKey").value = "";
    $("brainOutput").textContent = JSON.stringify(data.brain, null, 2);
    await loadStatus();
    await testGoogleSettings();
  } catch (error) {
    $("brainOutput").textContent = error.message;
  }
}

async function testGoogleSettings() {
  $("brainOutput").textContent = "Probando Google Gemini.";
  try {
    const data = await getJson("/settings/google/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    $("brainOutput").textContent = `${data.ok ? "Google Gemini operativo." : "Google Gemini no respondio."}\n\n${data.response}\n\n${JSON.stringify(data.brain, null, 2)}`;
    await loadStatus();
  } catch (error) {
    $("brainOutput").textContent = error.message;
  }
}

async function startCodexLogin() {
  $("codexLoginBox").hidden = false;
  $("codexLoginStatus").textContent = "Generando codigo de OpenAI.";
  $("brainOutput").textContent = "Iniciando sesion con Codex.";
  try {
    const data = await getJson("/settings/codex-login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    renderCodexLogin(data.login);
    if (state.codexLoginTimer) clearInterval(state.codexLoginTimer);
    state.codexLoginTimer = setInterval(pollCodexLogin, 3000);
  } catch (error) {
    $("codexLoginStatus").textContent = error.message;
    $("brainOutput").textContent = error.message;
  }
}

async function pollCodexLogin() {
  try {
    const data = await getJson("/settings/codex-login/status");
    renderCodexLogin(data.login);
    if (["connected", "failed", "expired"].includes(data.login.state)) {
      clearInterval(state.codexLoginTimer);
      state.codexLoginTimer = null;
      await loadStatus();
    }
  } catch (error) {
    $("codexLoginStatus").textContent = error.message;
  }
}

function renderCodexLogin(login) {
  $("codexLoginBox").hidden = false;
  if (login.url) {
    $("codexLoginUrl").href = login.url;
    $("codexLoginUrl").textContent = login.url;
  }
  if (login.code) $("codexLoginCode").textContent = login.code;
  const labels = {
    waiting_for_browser: "Abre OpenAI, introduce el codigo y autoriza Codex.",
    connected: "Codex conectado con tu cuenta de OpenAI.",
    failed: login.detail || "No se pudo completar el login.",
    expired: login.detail || "El codigo ha caducado.",
    idle: "Sin login activo."
  };
  $("codexLoginStatus").textContent = labels[login.state] || login.state || "Esperando.";
  $("brainOutput").textContent = JSON.stringify(login.brain || login, null, 2);
}

async function importCodexAuth(event) {
  event.preventDefault();
  const file = $("codexAuthFile").files[0];
  if (!file) {
    $("brainOutput").textContent = "Selecciona el auth.json de Codex.";
    return;
  }
  $("brainOutput").textContent = "Importando auth.json de Codex.";
  try {
    const authJson = await file.text();
    const data = await getJson("/settings/codex-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth_json: authJson })
    });
    $("codexAuthFile").value = "";
    $("brainOutput").textContent = JSON.stringify(data.brain, null, 2);
    await loadStatus();
  } catch (error) {
    $("brainOutput").textContent = error.message;
  }
}

async function loadDocker() {
  const data = await getJson("/docker");
  renderContainers(data);
}

function renderContainers(data) {
  const target = $("containerList");
  if (!data.available) {
    target.innerHTML = row("Docker no disponible", data.error || "Socket no montado", "warning");
    return;
  }
  target.innerHTML = data.containers.slice(0, 10).map((item) => {
    const tone = item.status === "running" ? "" : "warning";
    return row(item.name, `${item.status} - ${item.image}`, tone);
  }).join("") || row("Sin contenedores", "Registro vacio", "warning");
}

function renderIncidents(items) {
  const html = items.map((item) => row(item.summary, `${item.category} - ${item.created_at}`, item.severity === "warning" ? "warning" : "")).join("");
  $("incidentList").innerHTML = html || row("Sin incidentes", "Memoria limpia", "");
}

async function loadAssets() {
  const data = await getJson("/assets");
  $("assetList").innerHTML = data.map((item) => row(item.asset_id, `Conectado ${item.connected_at}`, "")).join("") || row("Sin assets", "Arranca el puente remoto", "warning");
}

async function loadBridgeConfig() {
  const data = await getJson("/asset-bridge/config");
  const origin = window.location.origin.replace(/^http/, "ws");
  $("bridgeCommand").textContent = `python asset_bridge.py --server ${origin}${data.websocket_path} --asset-id ${data.asset_id} --key "${data.bridge_key}"`;
}

async function sendAssetCommand() {
  const assetId = $("assetId").value.trim();
  const action = $("assetAction").value;
  const payload = action === "launch" ? { app: $("assetApp").value.trim() } : {};
  $("assetOutput").textContent = "Enviando.";
  try {
    const data = await getJson(`/assets/${encodeURIComponent(assetId)}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload })
    });
    $("assetOutput").textContent = JSON.stringify(data, null, 2);
    await loadAssets();
  } catch (error) {
    $("assetOutput").textContent = error.message;
  }
}

function toggleDictation() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    appendMessage("assistant", "Dictado no disponible en este navegador.");
    return;
  }
  if (state.listening && state.recognition) {
    state.recognition.stop();
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "es-ES";
  recognition.interimResults = false;
  recognition.continuous = false;
  recognition.onstart = () => {
    state.listening = true;
    $("listenVoice").classList.add("active-recording");
  };
  recognition.onend = () => {
    state.listening = false;
    $("listenVoice").classList.remove("active-recording");
  };
  recognition.onresult = (event) => {
    const text = event.results[0][0].transcript;
    $("promptInput").value = text;
    sendChat(text);
  };
  state.recognition = recognition;
  recognition.start();
}

function appendMessage(role, content) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = content;
  $("transcript").appendChild(node);
  scrollTranscript();
  return node;
}

function scrollTranscript() {
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

function speak(text, force) {
  const cleanText = cleanAssistantText(text);
  if (!cleanText || !("speechSynthesis" in window)) return;
  if (!force && !$("voiceToggle").checked) return;
  stopVoice();
  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.lang = /[áéíóúñ¿¡]/i.test(cleanText) ? "es-ES" : "en-GB";
  utterance.rate = 1;
  utterance.pitch = 0.92;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find((voice) => voice.lang === utterance.lang) || voices.find((voice) => voice.lang.startsWith(utterance.lang.slice(0, 2)));
  if (preferred) utterance.voice = preferred;
  window.speechSynthesis.speak(utterance);
}

function stopVoice() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  if (state.recognition && state.listening) state.recognition.stop();
}

function cleanAssistantText(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !isTerminalNoise(line)).join("\n").trim();
}

function isTerminalNoise(line) {
  const lower = line.toLowerCase();
  if ([">", "$", "❯"].includes(line)) return true;
  if (/^[-_|+=~: .[\]()0-9]{12,}$/.test(line)) return true;
  return ["gpt-", "msg=interrupt", "/queue", "/bg", "/steer", "ctrl+c", "tokens", "private telemetry", "current local telemetry"].some((fragment) => lower.includes(fragment));
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
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

refreshAll();
