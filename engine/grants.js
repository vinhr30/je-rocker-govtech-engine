const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { loadStateOpportunities } = require('./opportunities');

const ROOT = path.join(__dirname, '..');
const GRANTS_DB = path.join(ROOT, 'grant_scraper', 'data', 'grants.db');

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
  return String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeFederalGrant(row) {
  return {
    id: clean(row.opportunity_number || row.external_id || row.id),
    title: clean(row.title) || 'Untitled grant',
    agency: clean(row.agency || row.agency_code),
    cfda: clean(row.cfda_numbers),
    deadline: clean(row.close_date),
    eligibility: clean(row.applicant_types),
    amount: row.estimated_funding || row.award_ceiling || row.award_floor || null,
    description: clean(row.description),
    stateCode: '',
    source: 'federal',
    url: clean(row.url),
  };
}

function normalizeStateGrant(item) {
  return {
    id: item.id,
    title: item.title,
    agency: item.agency,
    cfda: '',
    deadline: item.deadline,
    eligibility: '',
    amount: null,
    description: item.description,
    stateCode: item.stateCode,
    source: 'state',
    url: item.url,
  };
}

async function loadFederalGrants() {
  let db;
  try {
    db = await openReadOnly(GRANTS_DB);
    const rows = await allAsync(db, `SELECT * FROM grants_normalized WHERE title IS NOT NULL ORDER BY close_date IS NULL, close_date ASC`);
    return rows.map(normalizeFederalGrant).filter((grant) => grant.id && grant.title);
  } catch {
    return [];
  } finally {
    if (db) await closeAsync(db);
  }
}

async function loadStateGrants() {
  const opportunities = await loadStateOpportunities();
  return opportunities.filter((item) => /grant/i.test([item.title, item.type, item.description].join(' '))).map(normalizeStateGrant);
}

async function loadLiveGrants() {
  const [federal, state] = await Promise.all([loadFederalGrants(), loadStateGrants()]);
  return [...federal, ...state];
}

function scoreGrant(grant, client = {}) {
  const preferredAgencies = String(client.preferred_agencies || client.agency || '').toLowerCase();
  const keywords = String(client.keywords || client.notes || '').toLowerCase().split(/[,;\s]+/).filter((word) => word.length > 2);
  const text = [grant.title, grant.agency, grant.description].join(' ').toLowerCase();
  let score = 50;
  const reasons = [];
  if (preferredAgencies && preferredAgencies.split(/[,;]+/).some((agency) => agency.trim() && grant.agency.toLowerCase().includes(agency.trim()))) {
    score += 25;
    reasons.push('agency alignment');
  }
  const hits = keywords.filter((keyword) => text.includes(keyword));
  if (hits.length) {
    score += Math.min(20, hits.length * 5);
    reasons.push('keyword alignment');
  }
  if (grant.deadline) score += 5;
  return { score: Math.min(100, score), reason: reasons.join(', ') || 'live grant available' };
}

function prioritizeGrants(grants, client, limit = 20) {
  return grants.map((grant) => ({ ...grant, ...scoreGrant(grant, client) })).sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { loadFederalGrants, loadStateGrants, loadLiveGrants, prioritizeGrants };
