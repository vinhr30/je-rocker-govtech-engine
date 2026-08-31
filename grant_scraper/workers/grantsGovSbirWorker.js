const { fetchJson } = require('../lib/http');
const { writeRecords } = require('./baseWorker');
const { getSource } = require('../lib/registry');

const SBIR_KEYWORDS = ['SBIR', 'STTR'];
const GRANTS_GOV_ENDPOINT = 'https://api.grants.gov/v1/api/search2';

/**
 * sbir.gov's solicitations API returns HTTP 403 and the agency SBIR sites are
 * navigation pages with no machine-readable listings, so agency SBIR/STTR
 * notices are sourced from their Grants.gov postings and filtered by agency.
 */
function matchesAgency(hit, agencyCode) {
  const code = String(hit.agencyCode || '').toUpperCase();
  return code === agencyCode || code.startsWith(`${agencyCode}-`);
}

function toRecord(hit, source) {
  return {
    externalId: String(hit.id || hit.number),
    url: hit.id ? `https://www.grants.gov/search-results-detail/${hit.id}` : null,
    record: { ...hit, sbirAgency: source.agencyCode, sbirSourceId: source.id },
  };
}

function createGrantsGovSbirWorker(sourceId) {
  const source = getSource(sourceId);

  return {
    id: source.id,
    source,
    async run({ db, fetchImpl, env, now = () => new Date().toISOString() } = {}) {
      if (!db) throw new Error(`Worker ${source.id} requires a database handle`);

      const hits = new Map();
      for (const keyword of SBIR_KEYWORDS) {
        const payload = await fetchJson(
          { ...source, endpoint: GRANTS_GOV_ENDPOINT, method: 'POST', body: { rows: 500, keyword, oppStatuses: 'forecasted|posted' } },
          { fetchImpl, env },
        );
        const oppHits = (payload && payload.data && payload.data.oppHits) || [];
        for (const hit of oppHits) {
          if (matchesAgency(hit, source.agencyCode)) hits.set(String(hit.id), hit);
        }
      }

      const parsed = [...hits.values()].map((hit) => toRecord(hit, source));
      const fetchedAt = now();
      const written = await writeRecords(db, source, parsed, fetchedAt);

      return { sourceId: source.id, category: source.category, parsed: parsed.length, written, fetchedAt };
    },
  };
}

module.exports = { createGrantsGovSbirWorker, matchesAgency };
