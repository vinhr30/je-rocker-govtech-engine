const { fetchJson } = require('../lib/http');
const { getAsync, runAsync } = require('../lib/db');

const UPSERT_RAW = `
  INSERT INTO grants_raw (source_id, source_name, category, external_id, source_url, raw_json, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, external_id) DO UPDATE SET
    source_name = excluded.source_name,
    category = excluded.category,
    source_url = excluded.source_url,
    raw_json = excluded.raw_json,
    fetched_at = excluded.fetched_at
`;

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function firstDefined(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (value !== null && value !== undefined && value !== '') return String(value);
  }
  return null;
}

/**
 * Builds a worker that fetches a source, parses it into discrete records,
 * and writes each record's raw JSON into grants_raw.
 *
 * @param {object} source registry entry
 * @param {(payload: any) => Array<{externalId: string, url?: string, record: object}>} parse
 */
function createWorker(source, parse) {
  return {
    id: source.id,
    source,
    parse,
    async run({ db, fetchImpl, now = () => new Date().toISOString() } = {}) {
      if (!db) throw new Error(`Worker ${source.id} requires a database handle`);

      const payload = await fetchJson(source, { fetchImpl });
      const parsed = parse(payload).filter((item) => item && item.externalId);
      const fetchedAt = now();

      let written = 0;
      for (const item of parsed) {
        await runAsync(db, UPSERT_RAW, [
          source.id,
          source.name,
          source.category,
          item.externalId,
          item.url || null,
          JSON.stringify(item.record),
          fetchedAt,
        ]);
        written += 1;
      }

      return {
        sourceId: source.id,
        category: source.category,
        parsed: parsed.length,
        written,
        fetchedAt,
      };
    },
  };
}

async function findRawId(db, sourceId, externalId) {
  const row = await getAsync(db, 'SELECT id FROM grants_raw WHERE source_id = ? AND external_id = ?', [sourceId, externalId]);
  return row ? row.id : null;
}

module.exports = {
  asArray,
  createWorker,
  findRawId,
  firstDefined,
};
