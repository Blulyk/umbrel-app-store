const projectsEl = document.querySelector("#projects");
const statusEl = document.querySelector("#status");
const countEl = document.querySelector("#count");
const projectsDirEl = document.querySelector("#projectsDir");
const refreshButton = document.querySelector("#refresh");
const template = document.querySelector("#project-template");

let state = { projects: [], publicBaseUrl: "", projectsDir: "/projects" };

function setStatus(message, strong = "") {
  statusEl.innerHTML = strong ? `<strong>${strong}</strong> ${message}` : message;
}

async function api(route, options = {}) {
  const response = await fetch(route, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "No se pudo completar la accion");
  return body;
}

function projectMeta(project) {
  if (!project.hasIndex) return "Falta index.html";
  if (project.enabled) return "Publicado para cliente";
  return "Listo para publicar";
}

function render() {
  projectsEl.innerHTML = "";
  countEl.textContent = `${state.projects.length} ${state.projects.length === 1 ? "proyecto" : "proyectos"}`;
  projectsDirEl.textContent = state.projectsDir;

  if (!state.publicBaseUrl) {
    setStatus("Configura PUBLIC_BASE_URL con tu URL de Tailscale Funnel para ver enlaces completos.", "Funnel:");
  } else {
    setStatus(`Base publica: ${state.publicBaseUrl}`, "Funnel:");
  }

  if (!state.projects.length) {
    projectsEl.innerHTML = '<div class="empty">Crea carpetas dentro de proyectos, por ejemplo <code>web_fontanero</code>, con un <code>index.html</code>.</div>';
    return;
  }

  for (const project of state.projects) {
    const node = template.content.firstElementChild.cloneNode(true);
    const title = node.querySelector("h2");
    const meta = node.querySelector(".meta");
    const open = node.querySelector(".open");
    const copy = node.querySelector(".copy");
    const toggle = node.querySelector(".toggle");

    title.textContent = project.name;
    meta.textContent = projectMeta(project);

    open.href = project.publicUrl || "#";
    open.classList.toggle("disabled-link", !project.enabled);
    open.addEventListener("click", (event) => {
      if (!project.enabled) event.preventDefault();
    });

    copy.disabled = !project.enabled || !project.publicUrl;
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(project.publicUrl);
      setStatus(`Enlace copiado: ${project.publicUrl}`);
    });

    toggle.disabled = !project.hasIndex;
    toggle.textContent = project.enabled ? "Desactivar" : "Crear enlace";
    toggle.classList.add(project.enabled ? "enabled" : "disabled");
    toggle.addEventListener("click", async () => {
      const action = project.enabled ? "disable" : "enable";
      await api(`/api/projects/${encodeURIComponent(project.name)}/${action}`, { method: "POST" });
      await load();
    });

    projectsEl.appendChild(node);
  }
}

async function load() {
  refreshButton.disabled = true;
  try {
    state = await api("/api/projects");
    render();
  } catch (error) {
    setStatus(error.message, "Error:");
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", load);
load();
