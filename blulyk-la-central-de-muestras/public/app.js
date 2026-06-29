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

  setStatus(`Enlace unico de muestras: ${state.publicBaseUrl || "pendiente de configurar"}`, "Funnel:");

  if (!state.projects.length) {
    projectsEl.innerHTML = '<div class="empty">Crea carpetas dentro de proyectos, por ejemplo <code>web_fontanero</code>, con un <code>index.html</code>.</div>';
    return;
  }

  for (const project of state.projects) {
    const node = template.content.firstElementChild.cloneNode(true);
    const title = node.querySelector("h2");
    const meta = node.querySelector(".meta");
    const linkLine = node.querySelector(".link-line");
    const open = node.querySelector(".open");
    const copy = node.querySelector(".copy");
    const publish = node.querySelector(".publish");
    const unpublish = node.querySelector(".unpublish");

    title.textContent = project.name;
    meta.textContent = projectMeta(project);
    linkLine.textContent = project.enabled && project.publicUrl ? project.publicUrl : "Sin enlace publico activo";
    linkLine.classList.toggle("active", project.enabled && project.publicUrl);

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

    publish.disabled = !project.hasIndex || project.enabled;
    publish.textContent = state.projects.some((item) => item.enabled) ? "Cambiar a esta web" : "Publicar esta web";
    publish.addEventListener("click", async () => {
      const result = await api(`/api/projects/${encodeURIComponent(project.name)}/enable`, { method: "POST" });
      setStatus(`Muestra activa: ${project.name}. Enlace: ${result.project.publicUrl}`);
      await load();
    });

    unpublish.disabled = !project.enabled;
    unpublish.classList.add("danger");
    unpublish.addEventListener("click", async () => {
      await api(`/api/projects/${encodeURIComponent(project.name)}/disable`, { method: "POST" });
      setStatus(`Enlace despublicado para ${project.name}`);
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
