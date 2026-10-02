// Settings shared by the smoke runner (run-smoke.mjs) and the Playwright configuration.
//
// The published ports use the variable names of the Compose demo overlay, so one setting moves both the stack
// and the browser. Defaults are the fixed ports of the build plan (R-05 and I.3).

const PORT = /^[1-9][0-9]{0,4}$/;

function port(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!PORT.test(raw) || Number(raw) > 65535) throw new Error(`${name} must be a TCP port (1 to 65535), got "${raw}"`);
  return Number(raw);
}

/** Ports and URLs of the smoke stack, read from the environment. */
export function smokeSettings(env = process.env) {
  const httpPort = port(env, 'MSCD_HTTP_PORT', 18080);
  const httpsPort = port(env, 'MSCD_HTTPS_PORT', 18443);
  const keycloakPort = port(env, 'MSCD_KEYCLOAK_PORT', 18088);
  const mailpitPort = port(env, 'MSCD_MAILPIT_PORT', 18025);
  return {
    httpPort,
    httpsPort,
    keycloakPort,
    mailpitPort,
    baseUrl: `http://localhost:${httpPort}`,
    mailpitUrl: `http://127.0.0.1:${mailpitPort}`,
    // Keycloak's issuer is http://keycloak:18088 for the browser and the containers (I.3). Chromium maps the
    // name to the published port on this host.
    hostResolverRules: `MAP keycloak 127.0.0.1:${keycloakPort}`,
  };
}
