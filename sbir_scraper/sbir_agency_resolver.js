const path = require('path');
const { allAsync, runAsync, withSbirDatabase } = require('../grant_scraper/lib/db');

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'sbir.db');
const USER_AGENT = 'je-rocker-sbir-resolver/1.0';
const DOD_SEARCH = 'https://www.dodsbirsttr.mil/topics/api/public/topics/search';
const DOD_TOPIC_APP = 'https://www.dodsbirsttr.mil/topics-app/';

const UPSERT_DETAIL = `
  INSERT INTO sbir_topic_details (
    sbir_topic_id, abstract, deliverables, funding_min, funding_max,
    component, command, phase_hierarchy, attachments_json
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sbir_topic_id) DO UPDATE SET
    abstract = excluded.abstract,
    deliverables = excluded.deliverables,
    funding_min = excluded.funding_min,
    funding_max = excluded.funding_max,
    component = excluded.component,
    command = excluded.command,
    phase_hierarchy = excluded.phase_hierarchy,
    attachments_json = excluded.attachments_json
`;

function collapse(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Accepts "$150,000", "150k", "150000"; anything without a usable number is null. */
function parseFunding(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;

  const text = String(value).trim();
  const match = text.match(/\$?\s*([\d,]*\.?\d+)\s*([kKmM])?/);
  if (!match) return null;

  const base = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;

  const suffix = (match[2] || '').toLowerCase();
  const scale = suffix === 'k' ? 1000 : suffix === 'm' ? 1000000 : 1;
  return Math.round(base * scale);
}

/** DoD encodes phases as a phaseHierarchy JSON blob; flatten it to "I, II". */
function flattenPhaseHierarchy(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const values = (parsed.config || []).map((entry) => entry.displayValue).filter(Boolean);
    return values.length ? values.join(', ') : null;
  } catch {
    return null;
  }
}

function dodSearchUrl(topicNumber) {
  const searchParam = encodeURIComponent(JSON.stringify({
    searchText: topicNumber,
    components: null,
    programYear: null,
    solicitationCycleNames: [],
    releaseNumbers: [],
    topicReleaseStatus: [],
    modernizationPriorities: [],
    sortBy: null,
    technologyAreaIds: [],
    component: null,
    program: null,
  }));
  return `${DOD_SEARCH}?searchParam=${searchParam}&size=25&page=0`;
}

function dodAttachments(topic) {
  return (topic.baaInstructions || []).map((file) => ({
    uploadId: file.uploadId,
    filename: file.fileName || null,
    filetype: (file.fileName || '').split('.').pop()?.toLowerCase() || null,
    uploadTypeCode: file.uploadTypeCode || null,
    versionNumber: file.versionNumber ?? null,
  }));
}

/**
 * DoD topics resolve exactly by topic code through the public topics API.
 * The API carries no abstract, deliverables, or funding, so those stay null.
 */
async function resolveDod(row, { fetchImpl }) {
  const response = await fetchImpl(dodSearchUrl(row.topic_number), { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`DoD search returned ${response.status}`);

  const payload = await response.json();
  const topics = payload.data || [];
  const topic = topics.find((candidate) => candidate.topicCode === row.topic_number);
  if (!topic) return { resolved: false, reason: `no DoD topic matched ${row.topic_number}` };

  return {
    resolved: true,
    detail: {
      abstract: null,
      deliverables: null,
      fundingMin: null,
      fundingMax: null,
      component: collapse(topic.component) || null,
      command: collapse(topic.command) || null,
      phaseHierarchy: flattenPhaseHierarchy(topic.phaseHierarchy),
      attachments: dodAttachments(topic),
    },
  };
}

/**
 * Agencies without a verified per-topic endpoint. Each records why, so a
 * resolver can be added the moment a real source is confirmed.
 */
const UNRESOLVED_REASONS = {
  NSF: 'NSF topic codes are technology areas inside one solicitation; the NSF page carries neither the code nor the title',
  HHS: 'official_url already deep links to the authoritative posting; detail comes from the Grants.gov engine',
};

const RESOLVERS = { DOW: resolveDod, DOD: resolveDod };

function selectResolver(agency) {
  return RESOLVERS[String(agency || '').toUpperCase()] || null;
}

function unresolvedReason(agency) {
  const key = String(agency || '').toUpperCase();
  return UNRESOLVED_REASONS[key] || `no resolver implemented for ${key || 'unknown agency'}`;
}

async function resolveTopics({
  db,
  fetchImpl = globalThis.fetch,
  agency = null,
  limit = 5000,
  delayMs = 150,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  if (!db) throw new Error('resolveTopics requires a database handle');

  const params = [];
  let sql = 'SELECT * FROM sbir_topic_sources';
  if (agency) {
    sql += ' WHERE agency = ?';
    params.push(agency);
  }
  sql += ' ORDER BY id ASC LIMIT ?';
  params.push(limit);

  const rows = await allAsync(db, sql, params);
  const skipped = [];
  let resolved = 0;

  for (const row of rows) {
    const resolver = selectResolver(row.agency);
    if (!resolver) {
      skipped.push({ topicNumber: row.topic_number, agency: row.agency, reason: unresolvedReason(row.agency) });
      continue;
    }

    try {
      const result = await resolver(row, { fetchImpl });
      if (!result.resolved) {
        skipped.push({ topicNumber: row.topic_number, agency: row.agency, reason: result.reason });
        log(`[WARN] ${row.topic_number}: ${result.reason}`);
        continue;
      }

      const d = result.detail;
      await runAsync(db, UPSERT_DETAIL, [
        row.id,
        d.abstract,
        d.deliverables,
        parseFunding(d.fundingMin),
        parseFunding(d.fundingMax),
        d.component,
        d.command,
        d.phaseHierarchy,
        d.attachments && d.attachments.length ? JSON.stringify(d.attachments) : null,
      ]);
      resolved += 1;
      if (resolved % 10 === 0) log(`[INFO] resolved ${resolved} topics`);
    } catch (error) {
      skipped.push({ topicNumber: row.topic_number, agency: row.agency, reason: error.message });
      log(`[WARN] ${row.topic_number}: ${error.message}`);
    }

    if (delayMs) await sleep(delayMs);
  }

  const byAgency = {};
  for (const entry of skipped) byAgency[entry.agency] = (byAgency[entry.agency] || 0) + 1;

  return {
    candidates: rows.length,
    resolved,
    skipped: skipped.length,
    skippedByAgency: byAgency,
    skippedSample: skipped.slice(0, 3),
  };
}

async function run({ databasePath = DEFAULT_DB_PATH, ...options } = {}) {
  return withSbirDatabase(async (db) => {
    const result = await resolveTopics({ db, ...options });
    const rows = await allAsync(db, 'SELECT COUNT(*) AS n FROM sbir_topic_details');
    return { ...result, detailRows: rows[0].n };
  }, databasePath);
}

module.exports = {
  DEFAULT_DB_PATH,
  DOD_TOPIC_APP,
  dodAttachments,
  dodSearchUrl,
  flattenPhaseHierarchy,
  parseFunding,
  resolveDod,
  resolveTopics,
  run,
  selectResolver,
  unresolvedReason,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
  };

  run({ agency: getArg('--agency'), log: (message) => console.log(message) })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
