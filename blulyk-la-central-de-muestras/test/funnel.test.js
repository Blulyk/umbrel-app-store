import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFunnelSpec,
  dockerContainerName,
  hostnameForProject,
  sanitizeHostname
} from "../lib/funnel.js";

test("sanitizeHostname creates a valid Tailscale hostname", () => {
  assert.equal(sanitizeHostname("Peluqueria Raquel!"), "peluqueria-raquel");
  assert.equal(sanitizeHostname("web_fontanero"), "web-fontanero");
});

test("hostnameForProject includes the demo prefix", () => {
  assert.equal(hostnameForProject("peluqueria-raquel"), "muestra-peluqueria-raquel");
});

test("dockerContainerName is stable and safe", () => {
  assert.equal(dockerContainerName("peluqueria-raquel"), "muestra-peluqueria-raquel-ts");
});

test("buildFunnelSpec creates a dedicated Tailscale container definition", () => {
  const spec = buildFunnelSpec({
    projectName: "peluqueria-raquel",
    projectPath: "/projects/peluqueria-raquel",
    dataDir: "/data",
    tailnetDomain: "tailcbdb4e.ts.net",
    authKey: "tskey-auth-example"
  });

  assert.equal(spec.hostname, "muestra-peluqueria-raquel");
  assert.equal(spec.publicUrl, "https://muestra-peluqueria-raquel.tailcbdb4e.ts.net/");
  assert.equal(spec.containerName, "muestra-peluqueria-raquel-ts");
  assert.deepEqual(spec.env.TS_AUTHKEY, "tskey-auth-example");
  assert.deepEqual(spec.env.TS_HOSTNAME, "muestra-peluqueria-raquel");
  assert.match(spec.serveConfig, /"AllowFunnel"/);
  assert.match(spec.serveConfig, /"Proxy": "http:\/\/127\.0\.0\.1:80"/);
});
