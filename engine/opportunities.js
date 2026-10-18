const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '..');
const STATE_CODES = ['AZ', 'CA', 'FL', 'VA', 'NY', 'TX', 'CO', 'WA'];

function openReadOnly(databasePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(db)));
  });
}

function allAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || []))));
}

function closeAsync(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

function clean(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text && !/^\(?blank\)?$/i.test(text) && !/^unknown$/i.test(text) ? text : '';
}

function normalizeFederalOpportunity(row) {
  const id = clean(row.notice_id || row.id || row.solicitation_id || row.title);
  return {
    id,
    title: clean(row.title) || 'Untitled opportunity',
    agency: clean(row.agency || row.department || row.office),
    naics: clean(row.naics_code || row.naics || row.stableNaics),
    deadline: clean(row.response_date || row.deadline || row.due_date),
    type: clean(row.type || row.notice_type || row.set_aside || 'Opportunity'),
    description: clean(row.description || row.synopsis),
    stateCode: extractState(clean(row.place_of_performance || row.location || row.state)),
    source: 'federal',
    url: clean(row.url),
  };
}

function normalizeStateOpportunity(row, stateCode) {
  return {
    id: clean(row.solicitation_id || row.solicitation_number || row.event_id || row.cr_number || row.id),
    title: clean(row.title || row.event_name) || 'Untitled state opportunity',
    agency: clean(row.agency || row.department),
    naics: clean(row.stableNaics || row.naics || row.commodity_codes),
    deadline: clean(row.due_date || row.end_date || row.closing_date || row.closing_date_raw),
    type: clean(row.event_type || row.bid_type || row.category || row.ad_type || 'State opportunity'),
    description: clean(row.description || row.full_description || row.description_raw),
    stateCode,
    source: 'state',
    url: clean(row.url || row.detail_url),
  };
}

function extractState(value) {
  const text = String(value || '').toUpperCase();
  const match = text.match(/\b(AZ|CA|CO|FL|NY|TX|VA|WA)\b/);
  return match ? match[1] : '';
}

async function loadFederalFromJson() {
  const file = path.join(ROOT, 'opportunities.json');
  if (!fs.existsSync(file)) return [];
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(rows) ? rows.map(normalizeFederalOpportunity).filter((row) => row.id && row.title) : [];
  } catch {
    return [];
  }
}

async function loadSamApi() {
  const apiKey = process.env.SAM_API_KEY;
  if (!apiKey || typeof fetch !== 'function') return [];
  const postedFrom = process.env.SAM_POSTED_FROM || '01/01/2026';
  const postedTo = process.env.SAM_POSTED_TO || '12/31/2026';
  const url = new URL('https://api.sam.gov/opportunities/v2/search');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('postedFrom', postedFrom);
  url.searchParams.set('postedTo', postedTo);
  url.searchParams.set('limit', process.env.SAM_LIMIT || '1000');
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) return [];
    const body = await response.json();
    const rows = body.opportunitiesData || body.data || body.opportunities || [];
    return rows.map((row) => normalizeFederalOpportunity({
      id: row.noticeId || row.solicitationNumber,
      notice_id: row.noticeId || row.solicitationNumber,
      title: row.title,
      agency: row.fullParentPathName || row.department || row.organizationName,
      naics_code: row.naicsCode,
      response_date: row.responseDeadLine,
      type: row.type,
      description: row.description,
      place_of_performance: row.placeOfPerformance?.state?.code || row.placeOfPerformance?.city?.name,
      url: row.uiLink || row.links?.self,
    })).filter((row) => row.id && row.title);
  } catch {
    return [];
  }
}

async function loadStateOpportunities() {
  const items = [];
  for (const stateCode of STATE_CODES) {
    const databasePath = path.join(ROOT, 'data', `opportunities_${stateCode}.db`);
    if (!fs.existsSync(databasePath)) continue;
    let db;
    try {
      db = await openReadOnly(databasePath);
      const rows = await allAsync(db, 'SELECT * FROM normalized_listings');
      // url_status is set to 'expired' by scripts/verify_opportunity_urls.py for dead or past-due listings.
      items.push(...rows.filter((row) => row.url_status !== 'expired').map((row) => normalizeStateOpportunity(row, stateCode)).filter((row) => row.id && row.title));
    } catch {
      // Missing or partial state databases are allowed in live mode.
    } finally {
      if (db) await closeAsync(db);
    }
  }
  return items;
}

async function loadFederalOpportunities() {
  const apiRows = await loadSamApi();
  if (apiRows.length) return apiRows;
  return loadFederalFromJson();
}

async function loadLiveOpportunities() {
  const [federal, state] = await Promise.all([loadFederalOpportunities(), loadStateOpportunities()]);
  return [...federal, ...state];
}

function matchesQuery(item, query) {
  const text = [item.title, item.agency, item.naics, item.type, item.description, item.stateCode].join(' ').toLowerCase();
  return !query || text.includes(String(query).toLowerCase());
}

function summarizeOpportunities(items) {
  const agencyDistribution = {};
  const naicsDistribution = {};
  const deadlineWindows = {};
  for (const item of items) {
    if (item.agency) agencyDistribution[item.agency] = (agencyDistribution[item.agency] || 0) + 1;
    if (item.naics) naicsDistribution[item.naics] = (naicsDistribution[item.naics] || 0) + 1;
    const window = item.deadline ? String(item.deadline).slice(0, 7) : 'Unscheduled';
    deadlineWindows[window] = (deadlineWindows[window] || 0) + 1;
  }
  return { agencyDistribution, naicsDistribution, deadlineWindows };
}

module.exports = { loadFederalOpportunities, loadStateOpportunities, loadLiveOpportunities, matchesQuery, summarizeOpportunities };
