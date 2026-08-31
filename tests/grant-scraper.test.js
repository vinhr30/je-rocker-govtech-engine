const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../grant_scraper');
const { allAsync, withDatabase } = require('../grant_scraper/lib/db');
const { runNormalization } = require('../grant_scraper/pipeline/normalize');
const { runTopicExtraction } = require('../grant_scraper/pipeline/topics');

const EXPECTED_SOURCES = [
  'simpler_browser', 'grants_gov_simpler', 'grants_gov_full',
  'dod_sbir', 'nsf_sbir', 'nih_sbir', 'doe_sbir',
  'nasa_sbir', 'usda_sbir', 'dhs_sbir', 'dot_sbir',
  'arizona_grants', 'california_grants', 'florida_grants', 'virginia_grants',
];

const ENABLED_DAILY = ['simpler_browser', 'grants_gov_simpler', 'grants_gov_full', 'california_grants'];
const SBIR_SOURCES = ['dod_sbir', 'nsf_sbir', 'nih_sbir', 'doe_sbir', 'nasa_sbir', 'usda_sbir', 'dhs_sbir', 'dot_sbir'];

const ENV = { SIMPLER_GRANTS_API_KEY: 'test-key', CA_GRANTS_API_TOKEN: 'test-token' };

const BROWSER_FIXTURE = require('node:fs').readFileSync(
  require('node:path').join(__dirname, 'fixtures', 'simpler-search-page.html'),
  'utf8',
);

/** Keeps cadence tests hermetic; no real Chromium is ever launched. */
const fakeBrowserFactory = async () => ({
  newPage: async () => ({
    goto: async () => {},
    waitForSelector: async () => {},
    content: async () => BROWSER_FIXTURE,
    $: async () => ({ isDisabled: async () => true, click: async () => {} }),
  }),
  close: async () => {},
});

const RUN_OPTS = { env: ENV, browserFactory: fakeBrowserFactory, maxPages: 1, settleMs: 0, sleep: async () => {} };

function tempDbPath(label) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `grant-scraper-${label}-`)), 'grants.db');
}

const SIMPLER_PAYLOAD = {
  data: [{
    opportunity_id: 'SIM-1',
    opportunity_number: 'HHS-2026-001',
    opportunity_title: 'Rural Health Modernization',
    agency_name: 'HHS',
    opportunity_status: 'posted',
    summary: {
      post_date: '2026-02-01', close_date: '2026-05-01',
      award_floor: '50000', award_ceiling: '250000',
      summary_description: 'Modernize rural health IT.',
    },
  }],
};

// One hit per SBIR agency so each agency worker can be verified independently.
const GRANTS_GOV_PAYLOAD = {
  data: {
    oppHits: [
      { id: '1', number: 'NSF-1', title: 'NSF SBIR Phase I', agencyCode: 'NSF', agency: 'National Science Foundation', oppStatus: 'posted', openDate: '02/10/2026', closeDate: '06/10/2026' },
      { id: '2', number: 'NIH-1', title: 'NIH SBIR', agencyCode: 'HHS-NIH11', agency: 'NIH', oppStatus: 'posted', openDate: '02/11/2026', closeDate: '06/11/2026' },
      { id: '3', number: 'DOE-1', title: 'DOE STTR', agencyCode: 'DOE', agency: 'Energy', oppStatus: 'posted', openDate: '02/12/2026', closeDate: '06/12/2026' },
      { id: '4', number: 'USDA-1', title: 'USDA SBIR', agencyCode: 'USDA', agency: 'Agriculture', oppStatus: 'posted', openDate: '02/13/2026', closeDate: '06/13/2026' },
      { id: '5', number: 'DHS-1', title: 'DHS SBIR', agencyCode: 'DHS', agency: 'Homeland Security', oppStatus: 'posted', openDate: '02/14/2026', closeDate: '06/14/2026' },
      { id: '6', number: 'DOT-1', title: 'DOT SBIR', agencyCode: 'DOT', agency: 'Transportation', oppStatus: 'posted', openDate: '02/15/2026', closeDate: '06/15/2026' },
      { id: '7', number: 'DOC-1', title: 'Unrelated Commerce Grant', agencyCode: 'DOC', agency: 'Commerce', oppStatus: 'posted', openDate: '02/16/2026', closeDate: '06/16/2026' },
    ],
  },
};

const DOD_PAYLOAD = {
  total: 2,
  data: [
    { topicCode: 'A26-001', topicId: 111, topicTitle: 'Edge Autonomy', program: 'SBIR', component: 'ARMY', topicStatus: 'Open', topicStartDate: 1770000000000, topicEndDate: 1780000000000, solicitationTitle: 'DoD 26.1' },
    { topicCode: 'A26-002', topicId: 112, topicTitle: 'Sensor Fusion Research', program: 'STTR', component: 'NAVY', topicStatus: 'Open', topicStartDate: 1770000000000, topicEndDate: 1780000000000, solicitationTitle: 'DoD 26.1' },
  ],
};

const NASA_HTML = `<html><body><table>
<tr><th>Opportunity</th><th>Open Date</th><th>Close Date</th><th>Selection Announcement</th></tr>
<tr><td>SBIR Ignite | 2025 NASA SBIR Ignite Phase I</td><td>6/2/25</td><td>7/22/25</td><td>April 2026</td></tr>
<tr><td>Phase II | 2024 NASA STTR Phase II</td><td>7/25/25</td><td>9/8/25</td><td>April 2026</td></tr>
</table></body></html>`;

const CA_PAYLOAD = [{
  _id: 'CA-101', Title: 'Clean Energy Grant', AgencyDept: 'California Energy Commission',
  Status: 'active', ApplicationDeadline: '2026-07-01', Purpose: 'Fund clean energy pilots.',
  GrantURL: 'https://example.test/ca-101',
}];

/** fetchOpportunity returns one detail document per opportunity id. */
function detailFor(opportunityId) {
  const hit = GRANTS_GOV_PAYLOAD.data.oppHits.find((h) => String(h.id) === String(opportunityId));
  return {
    data: {
      id: Number(opportunityId),
      opportunityNumber: hit ? hit.number : `UNKNOWN-${opportunityId}`,
      opportunityTitle: hit ? hit.title : null,
      owningAgencyCode: hit ? hit.agencyCode : null,
      agencyDetails: { agencyName: hit ? hit.agency : null, agencyCode: hit ? hit.agencyCode : null },
      cfdas: [{ cfdaNumber: `10.${opportunityId}` }],
      opportunityCategory: { description: 'Discretionary' },
      synopsis: {
        awardFloor: '1000',
        awardCeiling: '50000',
        postingDate: hit ? hit.openDate : null,
        responseDate: hit ? hit.closeDate : null,
        synopsisDesc: 'Detail description',
      },
    },
  };
}

/** Routes fake payloads by endpoint so no network access is required. */
function createFakeFetch(overrides = {}) {
  return async (url, init) => {
    const respond = (payload) => ({
      ok: true, status: 200,
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    });

    if (url.includes('simpler.grants.gov')) return respond(overrides.simpler ?? SIMPLER_PAYLOAD);
    if (url.includes('dodsbirsttr.mil')) return respond(overrides.dod ?? DOD_PAYLOAD);
    if (url.includes('sbir.nasa.gov')) return respond(overrides.nasa ?? NASA_HTML);
    if (url.includes('fetchOpportunity')) {
      const body = init && init.body ? JSON.parse(init.body) : {};
      return respond(overrides.detail ?? detailFor(body.opportunityId));
    }
    if (url.includes('api.grants.gov')) return respond(overrides.grantsGov ?? GRANTS_GOV_PAYLOAD);
    if (url.includes('grants.ca.gov')) return respond(overrides.california ?? CA_PAYLOAD);
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

test('schema creates grants_raw, grants_normalized, and grant_topics', async () => {
  const tables = await withDatabase(
    (db) => allAsync(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
    tempDbPath('schema'),
  );
  const names = tables.map((row) => row.name);
  for (const table of ['grants_raw', 'grants_normalized', 'grant_topics']) {
    assert.ok(names.includes(table), `expected table ${table}`);
  }
});

test('registry contains every Phase D source with a worker', () => {
  assert.deepStrictEqual(engine.registry.map((s) => s.id).sort(), [...EXPECTED_SOURCES].sort());
  for (const id of EXPECTED_SOURCES) {
    assert.strictEqual(engine.getWorker(id).id, id);
  }
});

test('registry no longer references the blocked sbir.gov solicitations API', () => {
  for (const source of engine.registry) {
    assert.ok(!/api\.www\.sbir\.gov/.test(source.endpoint), `${source.id} still points at sbir.gov`);
    assert.ok(source.liveStatus, `${source.id} must declare a liveStatus`);
  }
});

test('registry applies the required cadences', () => {
  for (const source of engine.registry) {
    const expected = source.category === 'sbir' ? 'weekly' : 'daily';
    assert.strictEqual(source.cadence, expected, `${source.id} cadence`);
  }
  assert.strictEqual(engine.listSources({ category: 'sbir', includeDisabled: true }).length, 8);
  assert.strictEqual(engine.listSources({ category: 'state', includeDisabled: true }).length, 4);
});

test('sources without a confirmed feed are disabled rather than pointed at guesses', () => {
  for (const id of ['arizona_grants', 'florida_grants', 'virginia_grants']) {
    const source = engine.getSource(id);
    assert.strictEqual(source.enabled, false, `${id} should be disabled`);
    assert.strictEqual(source.liveStatus, 'no_machine_readable_source');
  }
});

test('credential-gated sources declare authRequired', () => {
  const simpler = engine.getSource('grants_gov_simpler');
  assert.strictEqual(simpler.authRequired, true);
  assert.strictEqual(simpler.authHeader, 'X-Auth');
  assert.strictEqual(simpler.authEnvVar, 'SIMPLER_GRANTS_API_KEY');

  const california = engine.getSource('california_grants');
  assert.strictEqual(california.authRequired, true);
  assert.strictEqual(california.authEnvVar, 'CA_GRANTS_API_TOKEN');
});

test('the Simpler worker sends X-Auth and fails loudly without a key', async () => {
  const databasePath = tempDbPath('simpler-auth');
  let seenHeader = null;
  const fetchImpl = async (url, init) => {
    seenHeader = init.headers['X-Auth'];
    return { ok: true, status: 200, json: async () => SIMPLER_PAYLOAD, text: async () => '' };
  };

  await withDatabase(async (db) => {
    await engine.getWorker('grants_gov_simpler').run({ db, fetchImpl, env: ENV });
  }, databasePath);
  assert.strictEqual(seenHeader, 'test-key');

  await withDatabase(async (db) => {
    await assert.rejects(
      () => engine.getWorker('grants_gov_simpler').run({ db, fetchImpl, env: {} }),
      /requires SIMPLER_GRANTS_API_KEY/,
    );
  }, tempDbPath('simpler-noauth'));
});

test('scheduler groups Grants.gov and states daily, SBIR weekly', () => {
  assert.deepStrictEqual(engine.listWorkers({ cadence: 'daily' }).map((w) => w.id), ENABLED_DAILY);
  assert.deepStrictEqual(engine.listWorkers({ cadence: 'weekly' }).map((w) => w.id), SBIR_SOURCES);
  assert.deepStrictEqual([...engine.SCHEDULE.daily], ['grants_gov', 'state']);
  assert.deepStrictEqual([...engine.SCHEDULE.weekly], ['sbir']);
});

test('DoD worker ingests native topic records', async () => {
  const rows = await withDatabase(async (db) => {
    await engine.getWorker('dod_sbir').run({ db, fetchImpl: createFakeFetch(), env: ENV });
    return allAsync(db, 'SELECT external_id, raw_json FROM grants_raw ORDER BY external_id');
  }, tempDbPath('dod'));

  assert.deepStrictEqual(rows.map((r) => r.external_id), ['A26-001', 'A26-002']);
  assert.strictEqual(JSON.parse(rows[0].raw_json).topicTitle, 'Edge Autonomy');
});

test('NASA worker parses the HTML solicitation table', async () => {
  const rows = await withDatabase(async (db) => {
    await engine.getWorker('nasa_sbir').run({ db, fetchImpl: createFakeFetch(), env: ENV });
    return allAsync(db, 'SELECT external_id, raw_json FROM grants_raw ORDER BY external_id');
  }, tempDbPath('nasa'));

  assert.strictEqual(rows.length, 2);
  const record = JSON.parse(rows.find((r) => /Ignite/.test(r.external_id)).raw_json);
  assert.strictEqual(record['Open Date'], '6/2/25');
  assert.strictEqual(record.program, 'SBIR');
  assert.strictEqual(record.agency, 'NASA');
});

test('each Grants.gov-derived SBIR worker keeps only its own agency', async () => {
  const expected = {
    nsf_sbir: 'NSF-1', nih_sbir: 'NIH-1', doe_sbir: 'DOE-1',
    usda_sbir: 'USDA-1', dhs_sbir: 'DHS-1', dot_sbir: 'DOT-1',
  };

  for (const [sourceId, number] of Object.entries(expected)) {
    const rows = await withDatabase(async (db) => {
      await engine.getWorker(sourceId).run({ db, fetchImpl: createFakeFetch(), env: ENV });
      return allAsync(db, 'SELECT raw_json FROM grants_raw');
    }, tempDbPath(sourceId));

    assert.strictEqual(rows.length, 1, `${sourceId} should ingest exactly one hit`);
    assert.strictEqual(JSON.parse(rows[0].raw_json).number, number);
  }
});

test('ingestion is idempotent across repeated runs', async () => {
  const count = await withDatabase(async (db) => {
    const worker = engine.getWorker('grants_gov_full');
    await worker.run({ db, fetchImpl: createFakeFetch(), ...RUN_OPTS });
    await worker.run({ db, fetchImpl: createFakeFetch(), ...RUN_OPTS });
    return (await allAsync(db, 'SELECT id FROM grants_raw')).length;
  }, tempDbPath('idempotent'));

  assert.strictEqual(count, 7);
});

test('normalization maps every source shape into grants_normalized', async () => {
  const rows = await withDatabase(async (db) => {
    for (const worker of engine.listWorkers()) {
      await worker.run({ db, fetchImpl: createFakeFetch(), ...RUN_OPTS });
    }
    const result = await runNormalization(db);
    assert.strictEqual(result.failures.length, 0);
    return allAsync(db, 'SELECT * FROM grants_normalized');
  }, tempDbPath('normalize'));

  const browser = rows.find((r) => r.source_id === 'simpler_browser');
  assert.ok(browser, 'browser list rows are normalized');
  assert.match(browser.title, /^Spatial Ecology/);

  const detail = rows.find((r) => r.detail_raw_id !== null && r.cfda_numbers);
  assert.ok(detail, 'a detail layer row is normalized');
  assert.strictEqual(detail.opportunity_category, 'Discretionary', 'detail supplies category');
  assert.strictEqual(detail.award_ceiling, 50000, 'detail supplies funding range');

  const dod = rows.find((r) => r.source_id === 'dod_sbir');
  assert.strictEqual(dod.opportunity_number, 'A26-001');
  assert.strictEqual(dod.close_date, '2026-05-28', 'epoch millis convert to ISO');

  const nasa = rows.find((r) => r.source_id === 'nasa_sbir');
  assert.ok(nasa.title.includes('NASA SBIR Ignite'));
  assert.strictEqual(nasa.posted_date, '2025-06-02', 'M/D/YY converts to ISO');

  const california = rows.find((r) => r.source_id === 'california_grants');
  assert.strictEqual(california.agency, 'California Energy Commission');
});

test('topic extractor writes DoD SBIR and STTR topics into grant_topics', async () => {
  const topics = await withDatabase(async (db) => {
    for (const worker of engine.listWorkers({ cadence: 'weekly' })) {
      await worker.run({ db, fetchImpl: createFakeFetch(), ...RUN_OPTS });
    }
    const result = await runTopicExtraction(db);
    assert.strictEqual(result.failures.length, 0);
    return allAsync(db, 'SELECT * FROM grant_topics ORDER BY topic_number');
  }, tempDbPath('topics'));

  assert.strictEqual(topics.length, 2, 'only DoD publishes structured topics');
  assert.strictEqual(topics[0].topic_number, 'A26-001');
  assert.strictEqual(topics[0].program, 'SBIR');
  assert.strictEqual(topics[0].topic_title, 'Edge Autonomy');
  assert.strictEqual(topics[1].program, 'STTR');
});

test('scheduler runs both cadences and reports ingestion counts', async () => {
  const databasePath = tempDbPath('cadence');
  const fetchImpl = createFakeFetch();

  const daily = await engine.runCadence('daily', { databasePath, fetchImpl, ...RUN_OPTS });
  assert.deepStrictEqual(daily.ingestion.failures, []);
  assert.strictEqual(daily.ingestion.results.length, 4);

  const weekly = await engine.runCadence('weekly', { databasePath, fetchImpl, ...RUN_OPTS });
  assert.deepStrictEqual(weekly.ingestion.failures, []);
  assert.strictEqual(weekly.ingestion.results.length, 8);
  assert.strictEqual(weekly.topics.written, 2);

  const stats = await engine.getIngestionStats({ databasePath });
  assert.strictEqual(
    stats.grants_raw,
    16,
    '3 browser + 1 simpler list + 1 detail (detail follows the list layer) + 1 CA + 2 DoD + 2 NASA + 6 agency',
  );
  assert.strictEqual(stats.grant_topics, 2);
});

test('a failing source is isolated and does not stop the cadence', async () => {
  const fetchImpl = async (url, init) => {
    if (url.includes('api.simpler.grants.gov')) return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    return createFakeFetch()(url, init);
  };

  const daily = await engine.runCadence('daily', { databasePath: tempDbPath('failure'), fetchImpl, ...RUN_OPTS });
  assert.strictEqual(daily.ingestion.failures.length, 1);
  assert.strictEqual(daily.ingestion.failures[0].sourceId, 'grants_gov_simpler');
  assert.strictEqual(daily.ingestion.results.length, 3);
});

test('unknown cadence and unknown source are rejected', async () => {
  await assert.rejects(() => engine.runCadence('hourly', {}), /Unknown cadence/);
  assert.throws(() => engine.getWorker('nope'), /No worker registered/);
});
