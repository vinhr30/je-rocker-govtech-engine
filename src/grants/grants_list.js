(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GrantList = factory();
}(typeof self !== 'undefined' ? self : globalThis, function () {
  const CURRENCY = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(value) {
    if (value === null || value === undefined || value === '') return '—';
    const amount = Number(value);
    return Number.isFinite(amount) ? CURRENCY.format(amount) : '—';
  }

  function formatDate(value) {
    if (!value) return '—';
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  }

  function renderRow(grant) {
    const status = grant.status ? escapeHtml(grant.status) : 'Unknown';
    const relevance = grant.relevance
      ? `<span class="grant-row-score" title="Client relevance score">match ${grant.relevance.score}</span>`
      : '';

    return `
      <a class="grant-row" href="${escapeHtml(grant.href)}" data-opp-num="${escapeHtml(grant.oppNum)}">
        <span class="grant-row-main">
          <span class="grant-row-title">${escapeHtml(grant.title) || '(untitled)'}</span>
          <span class="grant-row-agency">${escapeHtml(grant.agency) || '—'}</span>
        </span>
        <span class="grant-row-meta">
          <span class="grant-row-deadline">${formatDate(grant.deadline)}</span>
          <span class="grant-row-status status-${status.toLowerCase().replace(/[^a-z]/g, '')}">${status}</span>
          <span class="grant-row-award">${formatMoney(grant.awardMin)} – ${formatMoney(grant.awardMax)}</span>
          ${relevance}
        </span>
      </a>
    `;
  }

  function renderList(payload) {
    const grants = (payload && payload.grants) || [];
    if (!grants.length) {
      const scoped = payload && payload.clientName
        ? `No grants match <strong>${escapeHtml(payload.clientName)}</strong> out of ${payload.unfilteredTotal || 0} open opportunities.`
        : 'No grants match the current view.';
      return `<p class="grant-empty">${scoped}</p>`;
    }

    const scope = payload.clientName
      ? `<p class="grant-scope">Filtered for <strong>${escapeHtml(payload.clientName)}</strong> — ${payload.total} of ${payload.unfilteredTotal || payload.total} relevant.</p>`
      : `<p class="grant-scope">${payload.total} open opportunities.</p>`;

    return `
      ${scope}
      <div class="grant-list-header">
        <span>Title / Agency</span>
        <span>Deadline · Status · Award range</span>
      </div>
      <div class="grant-list">${grants.map(renderRow).join('')}</div>
    `;
  }

  function buildListUrl(options) {
    const { clientId, limit, offset } = options || {};
    const params = new URLSearchParams();
    if (clientId) params.set('client_id', clientId);
    if (limit) params.set('limit', limit);
    if (offset) params.set('offset', offset);
    const query = params.toString();
    return query ? `/api/grants?${query}` : '/api/grants';
  }

  async function mountGrantsList(container, options) {
    const { fetchImpl = globalThis.fetch, clientId, limit, offset } = options || {};
    if (!container) return null;
    container.innerHTML = '<p class="grant-loading">Loading grants…</p>';

    try {
      const response = await fetchImpl(buildListUrl({ clientId, limit, offset }));
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
      const payload = await response.json();
      container.innerHTML = renderList(payload);
      return payload;
    } catch (error) {
      container.innerHTML = `<p class="grant-error">Could not load grants: ${escapeHtml(error.message)}</p>`;
      return null;
    }
  }

  return { buildListUrl, escapeHtml, formatDate, formatMoney, mountGrantsList, renderList, renderRow };
}));
