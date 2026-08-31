const DEFAULT_TIMEOUT_MS = 30000;
const USER_AGENT = 'je-rocker-grant-scraper/1.0';

/**
 * Some sources require a credential supplied through the environment
 * (for example the Simpler Grants.gov API key). The registry names the
 * header and the variable; the value itself is never stored in the repo.
 */
function buildHeaders(source, env) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...(source.headers || {}),
  };
  if (source.authHeader && source.authEnvVar) {
    const secret = env[source.authEnvVar];
    if (secret) headers[source.authHeader] = secret;
  }
  return headers;
}

function requireCredential(source, env) {
  if (source.authRequired && source.authEnvVar && !env[source.authEnvVar]) {
    throw new Error(`${source.id} requires ${source.authEnvVar} to be set`);
  }
}

/** Credentials for query-param APIs are appended at request time, never stored. */
function buildUrl(source, env) {
  if (!source.authQueryParam || !source.authEnvVar) return source.endpoint;
  const secret = env[source.authEnvVar];
  if (!secret) return source.endpoint;
  const url = new URL(source.endpoint);
  url.searchParams.set(source.authQueryParam, secret);
  return url.toString();
}

async function request(source, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation is available');
  }
  requireCredential(source, env);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init = {
      method: source.method || 'GET',
      headers: buildHeaders(source, env),
      signal: controller.signal,
    };
    if (init.method !== 'GET' && init.method !== 'HEAD') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(source.body || {});
    }

    const response = await fetchImpl(buildUrl(source, env), init);
    if (!response.ok) {
      throw new Error(`${source.id} request failed with status ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(source, options = {}) {
  const response = await request(source, options);
  return response.json();
}

async function fetchText(source, options = {}) {
  const response = await request(
    { ...source, headers: { Accept: 'text/html,application/xhtml+xml', ...(source.headers || {}) } },
    options,
  );
  return response.text();
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  USER_AGENT,
  buildHeaders,
  buildUrl,
  fetchJson,
  fetchText,
};
