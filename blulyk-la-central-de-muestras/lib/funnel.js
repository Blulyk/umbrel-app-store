import fs from "node:fs/promises";
import path from "node:path";

const MAX_HOSTNAME_LENGTH = 63;

export function sanitizeHostname(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HOSTNAME_LENGTH)
    .replace(/-+$/g, "");
  if (!slug) throw new Error("No se pudo crear un hostname valido");
  return slug;
}

export function hostnameForProject(projectName) {
  return sanitizeHostname(`muestra-${projectName}`);
}

export function dockerContainerName(projectName, role = "ts") {
  return sanitizeHostname(`${hostnameForProject(projectName)}-${role}`);
}

export function serveConfigFor(hostname, tailnetDomain) {
  const fqdn = `${hostname}.${tailnetDomain}`;
  return {
    TCP: {
      "443": {
        HTTPS: true
      }
    },
    Web: {
      [`${fqdn}:443`]: {
        Handlers: {
          "/": {
            Proxy: "http://127.0.0.1:80"
          }
        }
      }
    },
    AllowFunnel: {
      [`${fqdn}:443`]: true
    }
  };
}

export function buildFunnelSpec({ projectName, projectPath, hostProjectPath, dataDir, tailnetDomain, authKey }) {
  const hostname = hostnameForProject(projectName);
  const publicUrl = `https://${hostname}.${tailnetDomain}/`;
  const stateDir = path.join(dataDir, "funnels", projectName, "state");
  const configDir = path.join(dataDir, "funnels", projectName, "config");
  const serveConfig = JSON.stringify(serveConfigFor(hostname, tailnetDomain), null, 2);

  return {
    projectName,
    hostname,
    publicUrl,
    containerName: dockerContainerName(projectName, "ts"),
    webContainerName: dockerContainerName(projectName, "web"),
    projectPath,
    hostProjectPath: hostProjectPath || projectPath,
    stateDir,
    configDir,
    serveConfigPath: path.join(configDir, "serve.json"),
    serveConfig,
    env: {
      TS_AUTHKEY: authKey,
      TS_HOSTNAME: hostname,
      TS_STATE_DIR: "/var/lib/tailscale",
      TS_SERVE_CONFIG: "/config/serve.json",
      TS_EXTRA_ARGS: "--advertise-tags=tag:funnel"
    }
  };
}

export class FunnelManager {
  constructor({ docker, dataDir, hostProjectsDir, tailnetDomain, authKey }) {
    this.docker = docker;
    this.dataDir = dataDir;
    this.hostProjectsDir = hostProjectsDir;
    this.tailnetDomain = tailnetDomain;
    this.authKey = authKey;
  }

  specFor(project) {
    if (!this.tailnetDomain) throw new Error("Configura el dominio tailnet antes de publicar");
    if (!this.authKey) throw new Error("Configura una Tailscale auth key reutilizable antes de publicar");
    return buildFunnelSpec({
      projectName: project.name,
      projectPath: project.path,
      hostProjectPath: path.join(this.hostProjectsDir, project.name),
      dataDir: this.dataDir,
      tailnetDomain: this.tailnetDomain,
      authKey: this.authKey
    });
  }

  async publish(project) {
    if (!this.docker) throw new Error("Docker no esta disponible dentro de la app");
    const spec = this.specFor(project);
    await fs.mkdir(spec.stateDir, { recursive: true });
    await fs.mkdir(spec.configDir, { recursive: true });
    await fs.writeFile(spec.serveConfigPath, `${spec.serveConfig}\n`);

    await this.removeContainer(spec.webContainerName);
    await this.removeContainer(spec.containerName);

    const tailscale = await this.docker.createContainer({
      name: spec.containerName,
      Image: "tailscale/tailscale:latest",
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        Binds: [
          `${spec.stateDir}:/var/lib/tailscale`,
          `${spec.configDir}:/config:ro`
        ]
      },
      Labels: {
        "blulyk.central.project": project.name,
        "blulyk.central.role": "tailscale"
      }
    });
    await tailscale.start();

    const web = await this.docker.createContainer({
      name: spec.webContainerName,
      Image: "nginx:1.27-alpine",
      HostConfig: {
        NetworkMode: `container:${spec.containerName}`,
        RestartPolicy: { Name: "unless-stopped" },
        Binds: [
          `${spec.hostProjectPath}:/usr/share/nginx/html:ro`
        ]
      },
      Labels: {
        "blulyk.central.project": project.name,
        "blulyk.central.role": "web"
      }
    });
    await web.start();

    return spec;
  }

  async unpublish(projectName) {
    await this.removeContainer(dockerContainerName(projectName, "web"));
    await this.removeContainer(dockerContainerName(projectName, "ts"));
  }

  async removeContainer(name) {
    try {
      const container = this.docker.getContainer(name);
      await container.remove({ force: true });
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
  }
}
