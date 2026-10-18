const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { loadLiveGrants, prioritizeGrants } = require('./grants');
const { loadLiveOpportunities } = require('./opportunities');

const CLIENT_DB = path.join(__dirname, '..', 'client.db');

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(CLIENT_DB, (error) => (error ? reject(error) : resolve(db)));
  });
}

function getAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row || null))));
}

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function onRun(error) { return error ? reject(error) : resolve(this); }));
}

function closeAsync(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

function words(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
}

function list(value) {
  return String(value || '').split(/[,;|]+/).map((item) => item.trim()).filter(Boolean);
}

function scoreItem(item, client) {
  const clientNaics = list(client.naics);
  const clientAgencies = list(client.preferred_agencies);
  const clientKeywords = words([client.keywords, client.notes, client.past_performance].join(' '));
  const intake = safeJson(client.intake_answers);
  const geo = String(intake.geo || '').toUpperCase();
  const text = [item.title, item.agency, item.naics, item.description, item.stateCode].join(' ').toLowerCase();
  const reasons = [];
  let score = 0;
  if (clientNaics.some((naics) => item.naics && String(item.naics).includes(naics))) { score += 35; reasons.push('NAICS alignment'); }
  if (clientAgencies.some((agency) => agency && item.agency && item.agency.toLowerCase().includes(agency.toLowerCase()))) { score += 30; reasons.push('agency alignment'); }
  if (geo && item.stateCode === geo) { score += 15; reasons.push('geo alignment'); }
  const keywordHits = clientKeywords.filter((keyword) => text.includes(keyword));
  if (keywordHits.length) { score += Math.min(20, keywordHits.length * 4); reasons.push('keyword alignment'); }
  if (!score) { score = 10; reasons.push('available live item'); }
  return { ...item, score: Math.min(100, score), reason: reasons.join(', ') };
}

function scoreAxes(items, client) {
  const sample = items.slice(0, 50);
  const scored = sample.map((item) => scoreItem(item, client));
  const average = (values) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  return {
    naics: average(scored.map((item) => String(item.reason || '').includes('NAICS alignment') ? 100 : 0)),
    agency: average(scored.map((item) => String(item.reason || '').includes('agency alignment') ? 100 : 0)),
    geo: average(scored.map((item) => String(item.reason || '').includes('geo alignment') ? 100 : 0)),
    keyword: average(scored.map((item) => String(item.reason || '').includes('keyword alignment') ? 100 : 0)),
  };
}

function safeJson(value) {
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

async function ensureColumns(db) {
  const columns = [
    ['live_ingestion_score', 'INTEGER'],
    ['live_naics_score', 'INTEGER'],
    ['live_agency_score', 'INTEGER'],
    ['live_geo_score', 'INTEGER'],
    ['live_keyword_score', 'INTEGER'],
    ['live_opportunity_count', 'INTEGER'],
    ['live_grant_count', 'INTEGER'],
    ['live_matched_opportunities', 'TEXT'],
    ['live_matched_grants', 'TEXT'],
    ['live_risk_score', 'INTEGER'],
    ['live_modernization_score', 'INTEGER'],
    ['live_momentum_score', 'INTEGER'],
    ['live_readiness_score', 'INTEGER'],
    ['live_compliance_score', 'INTEGER'],
    ['live_ingestion_at', 'TEXT'],
  ];
  for (const [name, type] of columns) {
    await runAsync(db, `ALTER TABLE clients ADD COLUMN ${name} ${type}`).catch((error) => {
      if (!String(error.message || '').includes('duplicate column name')) throw error;
    });
  }
}

async function loadClient(clientId) {
  const db = await openDb();
  try {
    await ensureColumns(db);
    return await getAsync(db, 'SELECT * FROM clients WHERE client_id = ?', [Number(clientId)]);
  } finally {
    await closeAsync(db);
  }
}

async function runClientIngestion(clientId) {
  const db = await openDb();
  try {
    await ensureColumns(db);
    const client = await getAsync(db, 'SELECT * FROM clients WHERE client_id = ?', [Number(clientId)]);
    if (!client) throw new Error('Client not found');
    const [grants, opportunities] = await Promise.all([loadLiveGrants(), loadLiveOpportunities()]);
    const rankedOpportunities = opportunities.map((item) => scoreItem(item, client)).sort((a, b) => b.score - a.score);
    const rankedGrants = prioritizeGrants(grants, client, grants.length).map((grant) => ({ id: grant.id, title: grant.title, agency: grant.agency, deadline: grant.deadline, source: grant.source, stateCode: grant.stateCode, score: grant.score, reason: grant.reason }));
    const axisScores = scoreAxes([...rankedOpportunities, ...rankedGrants], client);
    const top = [...rankedOpportunities.slice(0, 10), ...rankedGrants.slice(0, 10)];
    const average = top.length ? Math.round(top.reduce((sum, item) => sum + Number(item.score || 0), 0) / top.length) : 0;
    const riskScore = Math.max(0, 100 - average);
    const modernizationScore = Math.max(axisScores.keyword, axisScores.naics);
    const momentumScore = rankedOpportunities.length + rankedGrants.length > 0 ? 75 : 0;
    const readinessScore = Math.round((average + axisScores.agency + axisScores.keyword) / 3);
    const complianceScore = axisScores.agency ? 85 : 65;
    const timestamp = new Date().toISOString();
    await runAsync(db, 'UPDATE clients SET live_ingestion_score = ?, live_naics_score = ?, live_agency_score = ?, live_geo_score = ?, live_keyword_score = ?, live_opportunity_count = ?, live_grant_count = ?, live_matched_opportunities = ?, live_matched_grants = ?, live_risk_score = ?, live_modernization_score = ?, live_momentum_score = ?, live_readiness_score = ?, live_compliance_score = ?, live_ingestion_at = ? WHERE client_id = ?', [average, axisScores.naics, axisScores.agency, axisScores.geo, axisScores.keyword, rankedOpportunities.length, rankedGrants.length, JSON.stringify(rankedOpportunities.slice(0, 50).map((item) => ({ id: item.id, title: item.title, agency: item.agency, score: item.score, reason: item.reason }))), JSON.stringify(rankedGrants.slice(0, 50).map((item) => ({ id: item.id, title: item.title, agency: item.agency, score: item.score, reason: item.reason }))), riskScore, modernizationScore, momentumScore, readinessScore, complianceScore, timestamp, Number(clientId)]);
    return { clientId: String(clientId), status: 'OK', finishedAt: timestamp, score: average, axisScores, signals: { risk: riskScore, modernization: modernizationScore, momentum: momentumScore, readiness: readinessScore, compliance: complianceScore }, opportunities: rankedOpportunities.slice(0, 50), grants: rankedGrants.slice(0, 50) };
  } finally {
    await closeAsync(db);
  }
}

async function getClientIngestionSummary(clientId) {
  const client = await loadClient(clientId);
  if (!client) throw new Error('Client not found');
  const [grants, opportunities] = await Promise.all([loadLiveGrants(), loadLiveOpportunities()]);
  const rankedOpportunities = opportunities.map((item) => scoreItem(item, client)).sort((a, b) => b.score - a.score).slice(0, 25);
  const rankedGrants = prioritizeGrants(grants, client, 25).map((grant) => ({ id: grant.id, title: grant.title, agency: grant.agency, deadline: grant.deadline, source: grant.source, stateCode: grant.stateCode, score: grant.score, reason: grant.reason }));
  const fallbackAxisScores = scoreAxes([...rankedOpportunities, ...rankedGrants], client);
  const valueOrFallback = (value, fallback) => {
    const number = Number(value || 0);
    return number > 0 ? number : Number(fallback || 0);
  };
  const axisScores = {
    naics: valueOrFallback(client.live_naics_score, fallbackAxisScores.naics),
    agency: valueOrFallback(client.live_agency_score, fallbackAxisScores.agency),
    geo: valueOrFallback(client.live_geo_score, fallbackAxisScores.geo),
    keyword: valueOrFallback(client.live_keyword_score, fallbackAxisScores.keyword),
  };
  const matchedOpportunities = safeJson(client.live_matched_opportunities);
  const matchedGrants = safeJson(client.live_matched_grants);
  const visibleOpportunities = matchedOpportunities.length ? matchedOpportunities : rankedOpportunities;
  const visibleGrants = matchedGrants.length ? matchedGrants : rankedGrants;
  const topItems = [...visibleOpportunities.slice(0, 10), ...visibleGrants.slice(0, 10)];
  const fallbackScore = topItems.length ? Math.round(topItems.reduce((sum, item) => sum + Number(item.score || 0), 0) / topItems.length) : 0;
  const score = valueOrFallback(client.live_ingestion_score, fallbackScore);
  const hasLiveMatches = visibleOpportunities.length + visibleGrants.length > 0;
  const fallbackSignals = {
    risk: hasLiveMatches ? Math.max(1, 100 - score) : 0,
    modernization: Math.max(axisScores.keyword, axisScores.naics, hasLiveMatches ? 65 : 0),
    momentum: hasLiveMatches ? 75 : 0,
    readiness: hasLiveMatches ? Math.max(1, Math.round((score + axisScores.agency + axisScores.keyword) / 3)) : 0,
    compliance: hasLiveMatches ? (axisScores.agency ? 85 : 65) : 0,
  };
  return {
    clientId: String(clientId),
    timestamp: client.live_ingestion_at || null,
    score,
    axisScores,
    counts: { opportunities: Number(client.live_opportunity_count || rankedOpportunities.length), grants: Number(client.live_grant_count || rankedGrants.length) },
    signals: {
      risk: valueOrFallback(client.live_risk_score, fallbackSignals.risk),
      modernization: valueOrFallback(client.live_modernization_score, fallbackSignals.modernization),
      momentum: valueOrFallback(client.live_momentum_score, fallbackSignals.momentum),
      readiness: valueOrFallback(client.live_readiness_score, fallbackSignals.readiness),
      compliance: valueOrFallback(client.live_compliance_score, fallbackSignals.compliance),
    },
    opportunities: visibleOpportunities,
    grants: visibleGrants,
  };
}

module.exports = { getClientIngestionSummary, loadClient, runClientIngestion, scoreItem };
