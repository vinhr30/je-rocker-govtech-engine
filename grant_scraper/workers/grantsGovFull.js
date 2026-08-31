const { fetchJson } = require('../lib/http');
const { allAsync, getAsync } = require('../lib/db');
const { writeRecords } = require('./baseWorker');
const { getSource } = require('../lib/registry');

const source = getSource('grants_gov_full');
const DEFAULT_DETAIL_LIMIT = 250;
const DEFAULT_BATCH_SIZE = 50;

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

/** Browser list rows that have no detail row yet, so a backfill can resume. */
async function pendingBrowserNumbers(db, limit) {
  const rows = await allAsync(
    db,
    `SELECT r.external_id FROM grants_raw r
     WHERE r.source_type = 'list' AND r.source_id = 'simpler_browser'
       AND NOT EXISTS (
         SELECT 1 FROM grants_raw d
         WHERE d.source_id = 'grants_gov_full' AND d.external_id = r.external_id
       )
     ORDER BY r.id ASC LIMIT ?`,
    [limit],
  );
  return rows.map((row) => row.external_id);
}

async function resolveTargets(db, { fetchImpl, env, limit }) {
  const hasBrowserLayer = await getAsync(
    db,
    "SELECT 1 AS present FROM grants_raw WHERE source_type = 'list' AND source_id = 'simpler_browser' LIMIT 1",
  );

  if (hasBrowserLayer) {
    return {
      numbers: await pendingBrowserNumbers(db, limit),
      ids: null,
      idSource: 'simpler_browser_list_layer',
    };
  }

  const fallback = await collectOpportunityIds(db, { fetchImpl, env, limit });
  return { numbers: null, ids: fallback.ids, idSource: fallback.idSource };
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
  async run({
    db,
    fetchImpl,
    env,
    detailLimit = DEFAULT_DETAIL_LIMIT,
    batchSize = DEFAULT_BATCH_SIZE,
    log = () => {},
    now = () => new Date().toISOString(),
  } = {}) {
    if (!db) throw new Error(`Worker ${source.id} requires a database handle`);

    const { numbers, ids, idSource } = await resolveTargets(db, { fetchImpl, env, limit: detailLimit });
    const work = numbers || ids || [];

    const failures = [];
    const fetchedAt = now();
    let buffer = [];
    let written = 0;
    let processed = 0;

    // Flush as we go so a long backfill keeps its progress if it is interrupted.
    const flush = async () => {
      if (!buffer.length) return;
      written += await writeRecords(db, source, buffer, fetchedAt);
      buffer = [];
    };

    for (const item of work) {
      processed += 1;
      try {
        const opportunityId = numbers ? await resolveIdByNumber(item, { fetchImpl, env }) : item;
        if (!opportunityId) {
          failures.push({ target: item, error: 'no Grants.gov id for opportunity number' });
        } else {
          const payload = await fetchJson(
            { ...source, method: 'POST', body: { opportunityId: Number(opportunityId) || opportunityId } },
            { fetchImpl, env },
          );
          if (payload && payload.data) buffer.push(toRecord(payload.data));
        }
      } catch (error) {
        failures.push({ target: item, error: error.message });
      }

      if (buffer.length >= batchSize) {
        await flush();
        log(`[INFO] detail backfill ${processed}/${work.length} (written ${written}, failed ${failures.length})`);
      }
    }

    await flush();

    return {
      sourceId: source.id,
      category: source.category,
      sourceType: source.sourceType,
      idSource,
      requested: work.length,
      parsed: written,
      written,
      detailFailures: failures.length,
      failureSample: failures.slice(0, 3),
      fetchedAt,
    };
  },
};
