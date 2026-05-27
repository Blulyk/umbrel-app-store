const modes = {
  chat: "Chat",
  setup: "Setup",
  model: "Modelo",
  status: "Estado",
  shell: "Shell"
};

let currentMode = "chat";
let socket;

const terminal = new Terminal({
  cursorBlink: true,
  convertEol: true,
  fontFamily: '"Cascadia Mono", "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
  fontSize: 15,
  lineHeight: 1.35,
  letterSpacing: 0,
  theme: {
    background: "#020909",
    foreground: "#ffe6cb",
    cursor: "#ffff89",
    selectionBackground: "#3b342d",
    black: "#041c1c",
    red: "#ff867a",
    green: "#b7e58c",
    yellow: "#ffff89",
    blue: "#9ad1ff",
    magenta: "#ffb4e6",
    cyan: "#9ff5e5",
    white: "#ffe6cb"
  }
});

const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById("terminal"));
fit.fit();

function setState(value) {
  document.getElementById("state").textContent = value;
  document.getElementById("sessionState").textContent = value === "conectado" ? "activa" : value;
}

function wsUrl(mode) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?mode=${encodeURIComponent(mode)}`;
}

function connect(mode) {
  if (socket) socket.close();
  currentMode = mode;
  document.getElementById("title").textContent = modes[mode];
  document.getElementById("activeMode").textContent = modes[mode];
  document.querySelectorAll(".mode").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  terminal.reset();
  terminal.writeln(`Hermes Agent - ${modes[mode]}`);
  terminal.writeln("");
  setState("conectando");

  socket = new WebSocket(wsUrl(mode));
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    setState("conectado");
    resize();
  };

  socket.onmessage = async (event) => {
    if (event.data instanceof ArrayBuffer) {
      const text = new TextDecoder().decode(event.data);
      terminal.write(text);
    } else {
      terminal.write(event.data);
    }
  };

  socket.onclose = () => setState("cerrado");
  socket.onerror = () => setState("error");
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function resize() {
  fit.fit();
  send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
}

terminal.onData((data) => send({ type: "input", data }));
window.addEventListener("resize", resize);

document.querySelectorAll(".mode").forEach((button) => {
  button.addEventListener("click", () => connect(button.dataset.mode));
});

document.getElementById("restart").addEventListener("click", () => connect(currentMode));
document.getElementById("clearTerminal").addEventListener("click", () => terminal.clear());

document.querySelectorAll(".quick").forEach((button) => {
  button.addEventListener("click", () => {
    terminal.focus();
    send({ type: "input", data: `${button.dataset.send}\n` });
  });
});

connect("chat");
