(() => {
  const typeByClass = [
    ['modernization-score', 'modernization'], ['modernization', 'modernization'], ['mod-posture', 'modernization'], ['client-modernization', 'modernization'],
    ['match-score', 'match'], ['opportunity-alignment', 'alignment'], ['opp-agency', 'agency-breakdown'], ['agency-breakdown', 'agency-breakdown'],
    ['risk-score', 'risk'], ['risk', 'risk'], ['eng-risk', 'risk'], ['posture-risk', 'risk'], ['client-risk', 'risk'], ['client-risk-breakdown', 'risk'],
    ['compliance', 'compliance'], ['compliance-status', 'compliance'], ['posture-compliance', 'compliance'], ['client-compliance', 'compliance'],
    ['readiness', 'readiness'], ['grants-readiness', 'readiness'], ['momentum', 'momentum'], ['opp-momentum', 'momentum'],
    ['forecasting', 'forecasting'], ['eng-forecasting', 'forecasting'], ['fc-signals', 'forecasting'], ['fc-trends', 'forecasting'], ['fc-spending', 'forecasting'], ['fc-outlook', 'forecasting'], ['fc-unlock', 'forecasting'], ['client-forecast', 'forecasting'],
    ['client-live-ingestion', 'ingestion'], ['ingestion-controls', 'ingestion'], ['top-opportunities', 'alignment'], ['client-priority-opps', 'alignment'],
    ['grants-top', 'top-grants-available'], ['grants-alignment', 'grant-alignment'], ['grant-stats', 'agency-breakdown'], ['grant-section', 'alignment'], ['grant-all', 'alignment'], ['prioritized-grants', 'alignment'], ['view-grants', 'top-grants-available'], ['full-feed', 'alignment'], ['opp-top', 'top-matched-opportunities'], ['opp-full', 'full-opportunity-feed'],
    ['action-box', 'action-checklist'], ['posture-box', 'posture-modernization'], ['system-intelligence-summary', 'summary-system'], ['eng-modernization', 'summary-engines'], ['eng-matcher', 'summary-engines'], ['eng-forecasting', 'summary-engines'], ['opp-windows', 'distribution-deadlines'], ['fc-unlock', 'forecasting'],
    ['mission', 'summary-mission'], ['pulse', 'summary-pulse'], ['score-forecast', 'score-forecast'], ['tier-forecast', 'tier-forecast'], ['modernization-impact', 'modernization-impact'], ['opportunity-unlock', 'opportunity-unlock'], ['grants-windows', 'grant-submission-windows'], ['new-grants', 'new-grants-posted'], ['new-opportunities', 'new-opportunities-posted'], ['new-agency-releases', 'agency-breakdown'], ['new-windows', 'new-windows-opening'],
    ['matcher-controls', 'log-matcher'], ['modernization-controls', 'log-modernization'], ['risk-controls', 'log-risk'], ['forecasting-controls', 'log-forecast'], ['prioritization-controls', 'log-prioritize'], ['automation-controls', 'log-automation'], ['engine-state', 'audit'], ['kill-controls', 'guardrails'], ['system-status', 'summary-system'],
  ];

  function activeClientId() {
    const selected = document.getElementById('clientDropdown')?.value;
    if (selected) return selected;
    if (window.activeClient) return window.activeClient;
    const dataClient = document.querySelector('[data-client-id]')?.dataset.clientId;
    return dataClient || '1';
  }

  function ensureModal() {
    let modal = document.getElementById('detail-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'detail-modal';
    modal.className = 'detail-modal modal-container hidden';
    modal.innerHTML = '<div class="detail-modal-card modal-content"><button type="button" class="detail-modal-close" aria-label="Close">x</button><h2 class="modal-title" id="detail-modal-title">Detail Panel</h2><div class="modal-body" id="detail-modal-body"></div></div>';
    document.body.appendChild(modal);
    modal.querySelector('.detail-modal-close').addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (event) => { if (event.target === modal) modal.classList.add('hidden'); });
    return modal;
  }

  function endpointFor(type, clientId) {
    const postureTypes = new Set(['modernization', 'compliance', 'risk', 'readiness', 'momentum']);
    const systemDetailTypes = new Set(['alignment', 'forecasting', 'score-forecast', 'tier-forecast', 'top-matched-opportunities', 'full-opportunity-feed', 'top-grants-available', 'grant-alignment', 'grant-submission-windows', 'new-grants-posted', 'new-opportunities-posted', 'new-windows-opening', 'opportunity-unlock', 'modernization-impact']);
    const clientPostureRoutes = new Set(['modernization', 'compliance', 'risk']);
    const hasClientContext = Boolean(document.getElementById('clientDropdown')?.value || window.activeClient || document.querySelector('[data-client-id]')?.dataset.clientId);
    if (type.startsWith('business-')) return '/system/business-driver/' + type.replace('business-', '');
    if (type === 'agency-breakdown') return '/system/agency-breakdown';
    if (type.startsWith('distribution-')) return '/system/agency-breakdown';
    if (type === 'summary-mission') return '/system/primary/mission';
    if (type === 'summary-pulse') return '/system/primary/pulse';
    if (type.startsWith('summary-')) return '/system/agency-breakdown';
    if (type === 'audit') return '/engine/audit';
    if (type === 'guardrails') return '/engine/guardrails/status';
    if (type === 'log-matcher') return '/engine/matcher/log';
    if (type === 'log-modernization') return '/engine/modernization/log';
    if (type === 'log-risk') return '/engine/risk/log';
    if (type === 'log-forecast') return '/engine/forecast/log';
    if (type === 'log-prioritize') return '/engine/prioritize/log';
    if (type === 'log-automation') return '/engine/automation/log';
    if (postureTypes.has(type) && !hasClientContext) return '/system/posture/' + type;
    if (systemDetailTypes.has(type) && !hasClientContext) return '/system/detail/' + type;
    if (clientPostureRoutes.has(type) && hasClientContext) return '/client/' + encodeURIComponent(clientId) + '/posture/' + type;
    if (type.startsWith('posture-') && !hasClientContext) return '/system/posture/' + type.replace('posture-', '');
    if (type.startsWith('action-')) return '/client/' + encodeURIComponent(clientId) + '/actions/' + type.replace('action-', '');
    if (type.startsWith('posture-')) return '/client/' + encodeURIComponent(clientId) + '/posture/' + type.replace('posture-', '');
    if (type === 'ingestion') return '/client/' + encodeURIComponent(clientId) + '/ingestion';
    return '/client/' + encodeURIComponent(clientId) + '/' + encodeURIComponent(type);
  }

  function componentHtml(component) {
    const title = component.url
      ? '<a href="' + escapeHtml(component.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(component.name || 'Component') + '</a>'
      : escapeHtml(component.name || 'Component');
    return '<article class="detail-component"><h4>' + title + '</h4>'
      + '<p><strong>Score:</strong> ' + escapeHtml(component.score ?? 'N/A') + '</p>'
      + '<p><strong>Reason:</strong> ' + escapeHtml(component.reason || 'Not available') + '</p>'
      + '<p><strong>Evidence:</strong> ' + escapeHtml(component.evidence || 'Not available') + '</p>'
      + '<p><strong>Recommendation:</strong> ' + escapeHtml(component.recommendation || 'Review manually') + '</p></article>';
  }

  function renderDetail(type, payload) {
    if (payload.components?.length) {
      return '<h2>' + escapeHtml(payload.title || 'Detail Panel') + '</h2>' + payload.components.map(componentHtml).join('');
    }
    if (type === 'agency-breakdown' || type.startsWith('distribution-') || type.startsWith('summary-')) {
      const rows = (payload.agencies || []).slice(0, 25).map((agency) => '<article class="detail-component"><h4>' + escapeHtml(agency.name) + '</h4><p>Type: ' + escapeHtml(agency.type) + '</p><p>Opportunities: ' + escapeHtml(agency.countOpportunities) + ' | Grants: ' + escapeHtml(agency.countGrants) + '</p><p>Relevance: ' + escapeHtml(agency.relevanceScore) + (agency.recommended ? ' | Recommended' : '') + '</p></article>').join('');
      return '<h2>Agency Breakdown</h2><p class="detail-desc">Explains live agency counts across federal and state opportunities and grants.</p>' + rows;
    }
    if (type === 'audit') {
      const rows = (Array.isArray(payload) ? payload : []).map((entry) => '<article class="detail-component"><h4>' + escapeHtml(entry.timestamp || 'Audit event') + '</h4><p>' + escapeHtml(entry.event || '') + '</p></article>').join('');
      return '<h2>Engine State Map</h2>' + (rows || '<p>No audit events recorded.</p>');
    }
    if (type === 'guardrails') {
      return '<h2>Guardrails</h2><article class="detail-component"><h4>Kill Switches</h4><p>Global: ' + escapeHtml(payload.killSwitch?.global ? 'ON' : 'OFF') + '</p><p>Killed Engines: ' + escapeHtml((payload.killedEngines || []).join(', ') || 'None') + '</p></article>';
    }
    if (type.startsWith('log-')) {
      const entries = Array.isArray(payload) ? payload : [];
      const rows = entries.map((entry) => '<article class="detail-component"><h4>' + escapeHtml(entry.finishedAt || entry.timestamp || 'Log entry') + '</h4><p>' + escapeHtml(JSON.stringify(entry)) + '</p></article>').join('');
      return '<h2>' + escapeHtml(type.replace('log-', '').replace(/-/g, ' ') + ' log') + '</h2>' + (rows || '<p>No log entries recorded.</p>');
    }
    if (type.startsWith('action-')) {
      const rows = (payload.items || []).map((item) => '<article class="detail-component"><h4>' + escapeHtml(item.name) + '</h4><p><strong>Reason:</strong> ' + escapeHtml(item.reason) + '</p><p><strong>Evidence:</strong> ' + escapeHtml(item.evidence) + '</p><p><strong>Recommendation:</strong> ' + escapeHtml(item.recommendation) + '</p><p><strong>Score impact:</strong> ' + escapeHtml(item.scoreImpact ?? 'N/A') + '</p></article>').join('');
      return '<h2>' + escapeHtml(payload.title || 'Action Detail') + '</h2>' + rows;
    }
    if (type === 'ingestion') {
      const opportunities = (payload.opportunities || []).slice(0, 10).map((item) => '<li>' + escapeHtml(item.title) + ' - ' + escapeHtml(item.agency) + ' - Score ' + escapeHtml(item.score) + ' - ' + escapeHtml(item.reason) + '</li>').join('');
      const grants = (payload.grants || []).slice(0, 10).map((item) => '<li>' + escapeHtml(item.title) + ' - ' + escapeHtml(item.agency) + ' - Score ' + escapeHtml(item.score) + ' - ' + escapeHtml(item.reason) + '</li>').join('');
      return '<h2>Client Ingestion Detail</h2><p>Timestamp: ' + escapeHtml(payload.timestamp || 'Not run') + '</p><h3>Alignment Summary</h3>'
        + '<p>NAICS: ' + escapeHtml(payload.axisScores?.naics || 0) + ' | Agency: ' + escapeHtml(payload.axisScores?.agency || 0) + ' | Geo: ' + escapeHtml(payload.axisScores?.geo || 0) + ' | Keyword: ' + escapeHtml(payload.axisScores?.keyword || 0) + '</p>'
        + '<h3>Intelligence Signals</h3><p>Risk: ' + escapeHtml(payload.signals?.risk || 0) + ' | Modernization: ' + escapeHtml(payload.signals?.modernization || 0) + ' | Momentum: ' + escapeHtml(payload.signals?.momentum || 0) + ' | Readiness: ' + escapeHtml(payload.signals?.readiness || 0) + ' | Compliance: ' + escapeHtml(payload.signals?.compliance || 0) + '</p>'
        + '<h3>Opportunity Alignment</h3><ol>' + opportunities + '</ol><h3>Grant Alignment</h3><ol>' + grants + '</ol>';
    }
    return '<h2>' + escapeHtml(payload.title || 'Detail Panel') + '</h2>';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inferType(block) {
    for (const [className, type] of typeByClass) {
      if (block.classList.contains(className)) return type;
    }
    return null;
  }

  async function openDetail(block) {
    const type = block.dataset.type || inferType(block);
    if (!type) return;
    const clientId = block.dataset.clientId || activeClientId();
    const modal = ensureModal();
    const title = modal.querySelector('#detail-modal-title');
    const body = modal.querySelector('#detail-modal-body');
    if (title) title.textContent = 'Detail Panel';
    body.innerHTML = '<h2>Loading detail...</h2>';
    modal.classList.remove('hidden');
    try {
      const response = await fetch(endpointFor(type, clientId), { cache: 'no-store' });
      if (!response.ok) throw new Error('Detail unavailable');
      const payload = await response.json();
      if (title) title.textContent = payload.title || type.replace(/-/g, ' ');
      body.innerHTML = renderDetail(type, payload);
    } catch (_) {
      body.innerHTML = '<h2>Detail unavailable</h2><p>This panel has no live explanation yet.</p>';
    }
  }

  function wireExplainability() {
    document.querySelectorAll('.outer-block').forEach((block) => {
      const type = block.dataset.type || inferType(block);
      if (!type || block.dataset.explainableBound === '1') return;
      block.dataset.type = type;
      block.dataset.explainableBound = '1';
      block.classList.add('explainable-box');
      block.tabIndex = block.tabIndex >= 0 ? block.tabIndex : 0;
      block.addEventListener('click', (event) => {
        if (event.target.closest('a,button,input,select,textarea,label')) return;
        openDetail(block);
      });
      block.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDetail(block);
        }
      });
    });
  }

  window.DashboardExplainability = { wireExplainability, openDetail };
  document.addEventListener('DOMContentLoaded', wireExplainability);
})();
