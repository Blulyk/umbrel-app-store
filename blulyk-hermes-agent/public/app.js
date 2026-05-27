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
  fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
  fontSize: 14,
  theme: {
    background: "#05070c",
    foreground: "#eef2ff",
    cursor: "#76e4f7",
    selectionBackground: "#334155"
  }
});

const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById("terminal"));
fit.fit();

function setState(value) {
  document.getElementById("state").textContent = value;
}

function wsUrl(mode) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?mode=${encodeURIComponent(mode)}`;
}

function connect(mode) {
  if (socket) socket.close();
  currentMode = mode;
  document.getElementById("title").textContent = modes[mode];
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

connect("chat");
