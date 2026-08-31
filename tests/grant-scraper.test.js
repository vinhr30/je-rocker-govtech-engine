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
  'grants_gov_simpler', 'grants_gov_full',
  'dod_sbir', 'nsf_sbir', 'nih_sbir', 'doe_sbir',
  'nasa_sbir', 'usda_sbir', 'dhs_sbir', 'dot_sbir',
  'arizona_grants', 'california_grants', 'florida_grants', 'virginia_grants',
];

function tempDbPath(label) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `grant-scraper-${label}-`)), 'grants.db');
}

const SBIR_PAYLOAD = [
  {
    solicitation_id: 'SOL-1',
    solicitation_title: 'Autonomous Systems Solicitation',
    solicitation_number: 'DOD-24-A',
    agency: 'Department of Defense',
    program: 'SBIR',
    open_date: '2026-01-05',
    close_date: '2026-03-05',
    solicitation_link: 'https://example.test/sol-1',
    solicitation_topics: [
      {
        topic_number: 'A24-001',
        topic_title: 'Edge Autonomy',
        topic_description: 'Autonomy at the tactical edge.',
        sbir_phase: 'Phase I',
        program: 'SBIR',
      },
      {
        topic_number: 'A24-002',
        topic_title: 'STTR Sensor Fusion',
        topic_description: 'Multi-sensor fusion research.',
        sbir_phase: 'Phase II',
        program: 'STTR',
      },
    ],
  },
];

const SIMPLER_PAYLOAD = {
  data: [
    {
      opportunity_id: 'SIM-1',
      opportunity_number: 'HHS-2026-001',
      opportunity_title: 'Rural Health Modernization',
      agency_name: 'HHS',
      opportunity_status: 'posted',
      summary: {
        post_date: '2026-02-01',
        close_date: '2026-05-01',
        award_floor: '50000',
        award_ceiling: '250000',
        summary_description: 'Modernize rural health IT.',
      },
    },
  ],
};

const FULL_PAYLOAD = {
  data: {
    oppHits: [
      {
        id: '360001',
        number: 'DOT-2026-77',
        title: 'Transit Data Systems',
        agencyCode: 'DOT',
        agency: 'Department of Transportation',
        oppStatus: 'posted',
        openDate: '02/10/2026',
        closeDate: '06/10/2026',
      },
    ],
  },
};

const STATE_PAYLOAD = {
  result: {
    records: [
      {
        _id: 'CA-101',
        Title: 'Clean Energy Grant',
        AgencyDept: 'California Energy Commission',
        Status: 'active',
        ApplicationDeadline: '2026-07-01',
        Purpose: 'Fund clean energy pilots.',
        GrantURL: 'https://example.test/ca-101',
      },
    ],
  },
};

/** Routes fake payloads by endpoint so no network access is required. */
function createFakeFetch(overrides = {}) {
  return async (url) => {
    let payload;
    if (url.includes('simpler.grants.gov')) payload = overrides.simpler ?? SIMPLER_PAYLOAD;
    else if (url.includes('api.grants.gov')) payload = overrides.full ?? FULL_PAYLOAD;
    else if (url.includes('sbir.gov')) payload = overrides.sbir ?? SBIR_PAYLOAD;
    else payload = overrides.state ?? STATE_PAYLOAD;

    return { ok: true, status: 200, json: async () => payload };
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
  const ids = engine.registry.map((source) => source.id);
  assert.deepStrictEqual(ids.sort(), [...EXPECTED_SOURCES].sort());
  for (const id of EXPECTED_SOURCES) {
    assert.strictEqual(engine.getWorker(id).id, id);
  }
});

test('registry applies the required cadences', () => {
  for (const source of engine.registry) {
    const expected = source.category === 'sbir' ? 'weekly' : 'daily';
    assert.strictEqual(source.cadence, expected, `${source.id} cadence`);
  }
  assert.strictEqual(engine.listSources({ category: 'grants_gov' }).length, 2);
  assert.strictEqual(engine.listSources({ category: 'sbir' }).length, 8);
  assert.strictEqual(engine.listSources({ category: 'state' }).length, 4);
});

test('scheduler groups Grants.gov and states daily, SBIR weekly', () => {
  const dailyWorkers = engine.listWorkers({ cadence: 'daily' }).map((w) => w.id);
  const weeklyWorkers = engine.listWorkers({ cadence: 'weekly' }).map((w) => w.id);

  assert.strictEqual(dailyWorkers.length, 6);
  assert.ok(dailyWorkers.includes('grants_gov_simpler'));
  assert.ok(dailyWorkers.includes('california_grants'));
  assert.strictEqual(weeklyWorkers.length, 8);
  assert.ok(weeklyWorkers.every((id) => id.endsWith('_sbir')));
  assert.deepStrictEqual([...engine.SCHEDULE.daily], ['grants_gov', 'state']);
  assert.deepStrictEqual([...engine.SCHEDULE.weekly], ['sbir']);
});

test('workers write raw JSON into grants_raw', async () => {
  const databasePath = tempDbPath('raw');
  const fetchImpl = createFakeFetch();

  const rows = await withDatabase(async (db) => {
    for (const worker of engine.WORKERS) {
      await worker.run({ db, fetchImpl });
    }
    return allAsync(db, 'SELECT source_id, external_id, raw_json FROM grants_raw ORDER BY source_id');
  }, databasePath);

  assert.strictEqual(rows.length, EXPECTED_SOURCES.length);
  const parsed = JSON.parse(rows.find((r) => r.source_id === 'dod_sbir').raw_json);
  assert.strictEqual(parsed.solicitation_title, 'Autonomous Systems Solicitation');
});

test('ingestion is idempotent across repeated runs', async () => {
  const databasePath = tempDbPath('idempotent');
  const fetchImpl = createFakeFetch();
  const worker = engine.getWorker('california_grants');

  const count = await withDatabase(async (db) => {
    await worker.run({ db, fetchImpl });
    await worker.run({ db, fetchImpl });
    const rows = await allAsync(db, 'SELECT id FROM grants_raw WHERE source_id = ?', ['california_grants']);
    return rows.length;
  }, databasePath);

  assert.strictEqual(count, 1);
});

test('normalization maps raw records into grants_normalized', async () => {
  const databasePath = tempDbPath('normalize');
  const fetchImpl = createFakeFetch();

  const rows = await withDatabase(async (db) => {
    for (const worker of engine.WORKERS) {
      await worker.run({ db, fetchImpl });
    }
    const result = await runNormalization(db);
    assert.strictEqual(result.failures.length, 0);
    assert.strictEqual(result.written, EXPECTED_SOURCES.length);
    return allAsync(db, 'SELECT * FROM grants_normalized ORDER BY source_id');
  }, databasePath);

  const simpler = rows.find((r) => r.source_id === 'grants_gov_simpler');
  assert.strictEqual(simpler.title, 'Rural Health Modernization');
  assert.strictEqual(simpler.close_date, '2026-05-01');
  assert.strictEqual(simpler.award_ceiling, 250000);

  const full = rows.find((r) => r.source_id === 'grants_gov_full');
  assert.strictEqual(full.opportunity_number, 'DOT-2026-77');
  assert.strictEqual(full.posted_date, '2026-02-10', 'MM/DD/YYYY should convert to ISO');

  const state = rows.find((r) => r.source_id === 'california_grants');
  assert.strictEqual(state.title, 'Clean Energy Grant');
  assert.strictEqual(state.agency, 'California Energy Commission');
});

test('topic extractor writes SBIR and STTR topics into grant_topics', async () => {
  const databasePath = tempDbPath('topics');
  const fetchImpl = createFakeFetch();

  const topics = await withDatabase(async (db) => {
    await engine.getWorker('dod_sbir').run({ db, fetchImpl });
    await engine.getWorker('california_grants').run({ db, fetchImpl });
    const result = await runTopicExtraction(db);
    assert.strictEqual(result.failures.length, 0);
    return allAsync(db, 'SELECT * FROM grant_topics ORDER BY topic_number');
  }, databasePath);

  assert.strictEqual(topics.length, 2, 'only SBIR sources produce topics');
  assert.strictEqual(topics[0].topic_number, 'A24-001');
  assert.strictEqual(topics[0].program, 'SBIR');
  assert.strictEqual(topics[0].phase, 'Phase I');
  assert.strictEqual(topics[1].program, 'STTR');
});

test('scheduler runs a full cadence and reports ingestion counts', async () => {
  const databasePath = tempDbPath('cadence');
  const fetchImpl = createFakeFetch();

  const daily = await engine.runCadence('daily', { databasePath, fetchImpl });
  assert.strictEqual(daily.ingestion.failures.length, 0);
  assert.strictEqual(daily.ingestion.results.length, 6);
  assert.strictEqual(daily.normalization.written, 6);
  assert.strictEqual(daily.topics.written, 0);

  const weekly = await engine.runCadence('weekly', { databasePath, fetchImpl });
  assert.strictEqual(weekly.ingestion.failures.length, 0);
  assert.strictEqual(weekly.ingestion.results.length, 8);
  assert.strictEqual(weekly.topics.written, 16, '8 SBIR sources x 2 topics');

  const stats = await engine.getIngestionStats({ databasePath });
  assert.strictEqual(stats.grants_raw, 14);
  assert.strictEqual(stats.grants_normalized, 14);
  assert.strictEqual(stats.grant_topics, 16);
});

test('a failing source is isolated and does not stop the cadence', async () => {
  const databasePath = tempDbPath('failure');
  const fetchImpl = async (url) => {
    if (url.includes('grants.az.gov')) return { ok: false, status: 503, json: async () => ({}) };
    return createFakeFetch()(url);
  };

  const daily = await engine.runCadence('daily', { databasePath, fetchImpl });
  assert.strictEqual(daily.ingestion.failures.length, 1);
  assert.strictEqual(daily.ingestion.failures[0].sourceId, 'arizona_grants');
  assert.strictEqual(daily.ingestion.results.length, 5);
});

test('unknown cadence and unknown source are rejected', async () => {
  await assert.rejects(() => engine.runCadence('hourly', {}), /Unknown cadence/);
  assert.throws(() => engine.getWorker('nope'), /No worker registered/);
});
