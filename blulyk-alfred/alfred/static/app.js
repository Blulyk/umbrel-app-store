const state = {
  transcript: [],
  lastAssistantText: ""
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
$("reloadIncidents").addEventListener("click", loadIncidents);
$("reloadAssets").addEventListener("click", loadAssets);
$("memoryRefresh").addEventListener("click", loadIncidents);
$("clearConsole").addEventListener("click", () => {
  stopVoice();
  state.transcript = [];
  state.lastAssistantText = "";
  renderTranscript();
});
$("repeatVoice").addEventListener("click", () => speak(state.lastAssistantText, true));
$("stopVoice").addEventListener("click", stopVoice);
$("voiceToggle").addEventListener("change", () => {
  if (!$("voiceToggle").checked) stopVoice();
});
$("loadBridge").addEventListener("click", loadBridgeConfig);
$("sendAssetCommand").addEventListener("click", sendAssetCommand);

$("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("promptInput");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  appendMessage("user", message);
  const assistant = appendMessage("assistant", "Assessing.");
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
      $("transcript").scrollTop = $("transcript").scrollHeight;
    }
    state.lastAssistantText = cleanAssistantText(assistant.textContent);
    assistant.textContent = state.lastAssistantText;
    if (!state.lastAssistantText) {
      assistant.remove();
      return;
    }
    if ($("voiceToggle").checked) speak(state.lastAssistantText, false);
  } catch (error) {
    assistant.textContent = `Console fault: ${error.message}`;
  }
});

async function refreshAll() {
  await Promise.allSettled([loadVitals(), loadThreats(), loadDocker(), loadIncidents(), loadAssets()]);
}

async function loadVitals() {
  const data = await getJson("/vitals");
  $("systemState").textContent = data.status;
  $("cpuMetric").textContent = percent(data.cpu_percent);
  $("ramMetric").textContent = percent(data.ram_percent);
  $("diskMetric").textContent = percent(data.disk_percent);
  $("tempMetric").textContent = data.cpu_temperature_c === null ? "Temperature unavailable" : `${data.cpu_temperature_c.toFixed(1)}C`;
  $("briefingTitle").textContent = data.status === "Nominal" ? "Systems nominal." : data.status;
  $("briefingText").textContent = data.notes.join(" ");
}

async function loadThreats() {
  const data = await getJson("/threats");
  $("threatMetric").textContent = data.status;
  $("threatSummary").textContent = data.anomalies.length ? `${data.anomalies.length} perimeter events` : data.summary;
}

async function loadDocker() {
  const data = await getJson("/docker");
  const target = $("containerList");
  if (!data.available) {
    target.innerHTML = row("Docker unavailable", data.error || "Socket not mounted.", "warning");
    return;
  }
  target.innerHTML = data.containers.slice(0, 8).map((item) => {
    const tone = item.status === "running" ? "" : "warning";
    return row(item.name, `${item.status} - ${item.image}`, tone);
  }).join("") || row("No containers found", "The registry is oddly quiet.", "warning");
}

async function loadIncidents() {
  const data = await getJson("/memory/incidents");
  const html = data.map((item) => row(item.summary, `${item.category} - ${item.created_at}`, item.severity === "warning" ? "warning" : "")).join("");
  $("incidentList").innerHTML = html || row("No incidents recorded", "A rare luxury.", "");
  $("memoryList").innerHTML = html || row("No incidents recorded", "The ledger is clean.", "");
}

async function loadAssets() {
  const data = await getJson("/assets");
  $("assetList").innerHTML = data.map((item) => row(item.asset_id, `Connected ${item.connected_at}`, "")).join("") || row("No assets connected", "Start asset_bridge.py on the remote PC.", "warning");
}

async function loadBridgeConfig() {
  const data = await getJson("/asset-bridge/config");
  const origin = window.location.origin.replace(/^http/, "ws");
  const command = `python asset_bridge.py --server ${origin}${data.websocket_path} --asset-id ${data.asset_id} --key "${data.bridge_key}"`;
  $("bridgeCommand").textContent = command;
}

async function sendAssetCommand() {
  const assetId = $("assetId").value.trim();
  const action = $("assetAction").value;
  const payload = action === "launch" ? { app: $("assetApp").value.trim() } : {};
  $("assetOutput").textContent = "Dispatching.";
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

function appendMessage(role, content) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = content;
  $("transcript").appendChild(node);
  $("transcript").scrollTop = $("transcript").scrollHeight;
  return node;
}

function renderTranscript() {
  $("transcript").innerHTML = "";
}

function speak(text, force) {
  const cleanText = cleanAssistantText(text);
  if (!cleanText || !("speechSynthesis" in window)) return;
  if (!force && !$("voiceToggle").checked) return;
  stopVoice();
  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.lang = /[áéíóúñ¿¡]/i.test(cleanText) ? "es-ES" : "en-GB";
  utterance.rate = 0.98;
  utterance.pitch = 0.88;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find((voice) => voice.lang === utterance.lang) || voices.find((voice) => voice.lang.startsWith(utterance.lang.slice(0, 2)));
  if (preferred) utterance.voice = preferred;
  window.speechSynthesis.speak(utterance);
}

function stopVoice() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function cleanAssistantText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isTerminalNoise(line))
    .join("\n")
    .trim();
}

function isTerminalNoise(line) {
  const lower = line.toLowerCase();
  if ([">", "$", "❯"].includes(line)) return true;
  if (lower.includes("$ hermes")) return true;
  if (/^[-_|+=~: .[\]()0-9]{12,}$/.test(line)) return true;
  return [
    "gpt-",
    "msg=interrupt",
    "/queue",
    "/bg",
    "/steer",
    "ctrl+c",
    "reflecting",
    "tokens",
    "alfred context follows",
    "private telemetry",
    "current local telemetry",
    "context:",
    "user request:"
  ].some((fragment) => lower.includes(fragment));
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function percent(value) {
  return typeof value === "number" ? `${value.toFixed(0)}%` : "--";
}

function row(title, detail, tone) {
  const escapedTitle = escapeHtml(title);
  const escapedDetail = escapeHtml(detail);
  return `<div class="row ${tone || ""}"><div><strong>${escapedTitle}</strong><br><small>${escapedDetail}</small></div><span>*</span></div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

refreshAll();
