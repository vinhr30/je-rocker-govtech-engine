(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./grants_list.js'));
  else root.GrantDetail = factory(root.GrantList);
}(typeof self !== 'undefined' ? self : globalThis, function (list) {
  const { escapeHtml, formatDate, formatMoney } = list;

  /** Grants.gov synopses ship as HTML; render them as plain text rather than trusting the markup. */
  function toPlainText(value) {
    if (!value) return '';
    return String(value)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function field(label, value, modifier) {
    return `
      <div class="grant-detail-field${modifier ? ` ${modifier}` : ''}">
        <div class="grant-detail-label">${escapeHtml(label)}</div>
        <div class="grant-detail-value">${value || '—'}</div>
      </div>
    `;
  }

  function renderFundingRange(range) {
    if (!range) return '—';
    const estimated = range.estimatedFunding
      ? `<div class="grant-detail-sub">Estimated program funding: ${formatMoney(range.estimatedFunding)}</div>`
      : '';
    return `${formatMoney(range.awardFloor)} – ${formatMoney(range.awardCeiling)}${estimated}`;
  }

  function renderAttachments(attachments) {
    if (!attachments || !attachments.length) {
      return '<span class="grant-detail-muted">No attachments published.</span>';
    }
    return `<ul class="grant-attachments">${attachments
      .map((file) => {
        const name = escapeHtml(file.name || file.fileName || 'Attachment');
        const description = file.description ? ` — ${escapeHtml(file.description)}` : '';
        return `<li>${name}${description}</li>`;
      })
      .join('')}</ul>`;
  }

  function renderDetail(grant) {
    if (!grant) return '<p class="grant-error">Grant not found.</p>';

    const pending = grant.hasDetail
      ? ''
      : '<p class="grant-notice">Detail layer has not been ingested for this opportunity yet.</p>';

    return `
      <div class="grant-detail">
        <a class="grant-back" href="/grant-engine" data-action="back">← Back to list</a>
        <h2 class="grant-detail-title">${escapeHtml(grant.title) || '(untitled)'}</h2>
        <p class="grant-detail-sub">${escapeHtml(grant.agency) || '—'} · ${escapeHtml(grant.oppNum)}</p>
        ${pending}
        <div class="grant-detail-grid">
          ${field('Opportunity category', escapeHtml(grant.opportunityCategory))}
          ${field('CFDA', escapeHtml(grant.cfda))}
          ${field('Funding range', renderFundingRange(grant.fundingRange))}
          ${field('Deadline', formatDate(grant.deadline))}
          ${field('Applicant types', escapeHtml(grant.applicantTypes), 'grant-detail-field--wide')}
          ${field('Attachments', renderAttachments(grant.attachments), 'grant-detail-field--wide')}
          ${field('Synopsis', escapeHtml(toPlainText(grant.synopsis)), 'grant-detail-field--wide grant-detail-field--scroll')}
        </div>
        ${grant.url ? `<a class="grant-detail-link" href="${escapeHtml(grant.url)}" target="_blank" rel="noreferrer">View on Grants.gov ↗</a>` : ''}
      </div>
    `;
  }

  async function mountGrantDetail(container, oppNum, options) {
    const { fetchImpl = globalThis.fetch } = options || {};
    if (!container) return null;
    container.innerHTML = '<p class="grant-loading">Loading grant detail…</p>';

    try {
      const response = await fetchImpl(`/api/grants/${encodeURIComponent(oppNum)}`);
      if (response.status === 404) {
        container.innerHTML = renderDetail(null);
        return null;
      }
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
      const payload = await response.json();
      container.innerHTML = renderDetail(payload.grant);
      return payload.grant;
    } catch (error) {
      container.innerHTML = `<p class="grant-error">Could not load grant: ${escapeHtml(error.message)}</p>`;
      return null;
    }
  }

  return { mountGrantDetail, renderAttachments, renderDetail, renderFundingRange, toPlainText };
}));
