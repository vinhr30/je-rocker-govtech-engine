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

async function fetchJson(source, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation is available');
  }

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

    const response = await fetchImpl(source.endpoint, init);
    if (!response.ok) {
      throw new Error(`${source.id} request failed with status ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  USER_AGENT,
  buildHeaders,
  fetchJson,
};
