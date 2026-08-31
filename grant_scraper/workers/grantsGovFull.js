const { fetchJson } = require('../lib/http');
const { allAsync } = require('../lib/db');
const { writeRecords } = require('./baseWorker');
const { getSource } = require('../lib/registry');

const source = getSource('grants_gov_full');
const DEFAULT_DETAIL_LIMIT = 250;

/** Resolves a Grants.gov opportunity id from an opportunity number. */
async function resolveIdByNumber(number, { fetchImpl, env }) {
  const payload = await fetchJson(
    {
      ...source,
      endpoint: source.listEndpoint,
      method: 'POST',
      body: { rows: 1, oppNum: number, oppStatuses: 'forecasted|posted' },
    },
    { fetchImpl, env },
  );
  const hits = (payload && payload.data && payload.data.oppHits) || [];
  return hits.length ? String(hits[0].id) : null;
}

/**
 * Detail ids follow the list layer: the browser list carries opportunity
 * numbers that are resolved to ids, and the Simpler API list carries ids
 * directly. With no list layer at all the search index seeds the work set.
 */
async function collectOpportunityIds(db, { fetchImpl, env, limit }) {
  const browserRows = await allAsync(
    db,
    "SELECT external_id FROM grants_raw WHERE source_type = 'list' AND source_id = 'simpler_browser' ORDER BY id ASC LIMIT ?",
    [limit],
  );
  if (browserRows.length) {
    const resolved = [];
    for (const row of browserRows) {
      const id = await resolveIdByNumber(row.external_id, { fetchImpl, env });
      if (id) resolved.push(id);
    }
    if (resolved.length) return { ids: resolved, idSource: 'simpler_browser_list_layer' };
  }

  const listRows = await allAsync(
    db,
    "SELECT raw_json FROM grants_raw WHERE source_type = 'list' AND source_id = 'grants_gov_simpler'",
  );

  const ids = [];
  for (const row of listRows) {
    const record = JSON.parse(row.raw_json);
    const id = record.legacy_opportunity_id || record.opportunity_id;
    if (id) ids.push(String(id));
  }
  if (ids.length) return { ids: ids.slice(0, limit), idSource: 'simpler_list_layer' };

  const payload = await fetchJson(
    {
      ...source,
      endpoint: source.listEndpoint,
      method: 'POST',
      body: { rows: limit, keyword: '', oppStatuses: 'forecasted|posted' },
    },
    { fetchImpl, env },
  );
  const hits = (payload && payload.data && payload.data.oppHits) || [];
  return { ids: hits.map((hit) => String(hit.id)).filter(Boolean), idSource: 'grants_gov_search_index' };
}

function toRecord(detail) {
  const body = detail.synopsis || detail.forecast || {};
  return {
    externalId: String(detail.opportunityNumber || detail.id),
    url: detail.id ? `https://www.grants.gov/search-results-detail/${detail.id}` : null,
    record: { ...detail, detailBody: body },
  };
}

module.exports = {
  id: source.id,
  source,
  async run({ db, fetchImpl, env, detailLimit = DEFAULT_DETAIL_LIMIT, now = () => new Date().toISOString() } = {}) {
    if (!db) throw new Error(`Worker ${source.id} requires a database handle`);

    const { ids, idSource } = await collectOpportunityIds(db, { fetchImpl, env, limit: detailLimit });

    const parsed = [];
    const failures = [];
    for (const opportunityId of ids) {
      try {
        const payload = await fetchJson(
          { ...source, method: 'POST', body: { opportunityId: Number(opportunityId) || opportunityId } },
          { fetchImpl, env },
        );
        if (payload && payload.data) parsed.push(toRecord(payload.data));
      } catch (error) {
        failures.push({ opportunityId, error: error.message });
      }
    }

    const fetchedAt = now();
    const written = await writeRecords(db, source, parsed, fetchedAt);

    return {
      sourceId: source.id,
      category: source.category,
      sourceType: source.sourceType,
      idSource,
      requested: ids.length,
      parsed: parsed.length,
      written,
      detailFailures: failures.length,
      fetchedAt,
    };
  },
};
