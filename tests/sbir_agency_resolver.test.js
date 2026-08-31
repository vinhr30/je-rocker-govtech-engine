const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureSbirSchema, openDatabase, closeAsync, allAsync, runAsync } = require('../grant_scraper/lib/db');
const {
  dodAttachments,
  dodSearchUrl,
  flattenPhaseHierarchy,
  parseFunding,
  resolveTopics,
  selectResolver,
  unresolvedReason,
} = require('../sbir_scraper/sbir_agency_resolver');

const noSleep = async () => {};

const DOD_TOPIC = {
  topicCode: 'OSW26BZ05-DV019',
  topicTitle: 'Collaborative Distributed Swarm Radar',
  component: 'OSD',
  command: 'RELIANCE 21',
  program: 'SBIR',
  solicitationNumber: '26.BZ',
  topicStatus: 'Open',
  phaseHierarchy: '{"config":[{"phase":"1","displayValue":"I"},{"phase":"2","displayValue":"II"}]}',
  baaInstructions: [
    { uploadId: 1838208, fileName: 'R21_SBIR_26BZ_R5_v2.pdf', uploadTypeCode: 'COMPONENT_FINAL_DOCUMENT_UPLOAD', versionNumber: 2 },
    { uploadId: 1838209, fileName: 'instructions.docx', uploadTypeCode: 'COMPONENT_FINAL_DOCUMENT_UPLOAD', versionNumber: 1 },
  ],
};

function tempDbPath(label) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `sbir-res-${label}-`)), 'sbir.db');
}

async function seedSources(label, rows) {
  const db = openDatabase(tempDbPath(label));
  await ensureSbirSchema(db);
  for (const row of rows) {
    await runAsync(
      db,
      `INSERT INTO sbir_topic_sources (sbir_topic_url, official_url, title, agency, solicitation_number, topic_number, phase)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.url, row.official || 'https://example.test/official', row.title || 'T', row.agency, row.solicitation || null, row.topicNumber, row.phase || null],
    );
  }
  return db;
}

function createDodFetch({ topics = [DOD_TOPIC], status = 200, calls = [] } = {}) {
  return async (url) => {
    calls.push(url);
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const param = JSON.parse(decodeURIComponent(url.match(/searchParam=([^&]+)/)[1]));
    const matched = topics.filter((t) => !param.searchText || t.topicCode.includes(param.searchText));
    return { ok: true, status: 200, json: async () => ({ total: matched.length, data: matched }) };
  };
}

test('resolver selection is driven by agency', () => {
  assert.strictEqual(typeof selectResolver('DOW'), 'function');
  assert.strictEqual(typeof selectResolver('dow'), 'function', 'agency match is case-insensitive');
  assert.strictEqual(typeof selectResolver('DOD'), 'function');
  assert.strictEqual(selectResolver('NSF'), null);
  assert.strictEqual(selectResolver('NASA'), null);
  assert.strictEqual(selectResolver(null), null);
});

test('agencies without a resolver record why', () => {
  assert.match(unresolvedReason('NSF'), /technology areas inside one solicitation/);
  assert.match(unresolvedReason('HHS'), /deep links/);
  assert.match(unresolvedReason('NASA'), /no resolver implemented/);
});

test('the DoD search url carries the topic number as its search text', () => {
  const url = dodSearchUrl('OSW26BZ05-DV019');
  const param = JSON.parse(decodeURIComponent(url.match(/searchParam=([^&]+)/)[1]));
  assert.strictEqual(param.searchText, 'OSW26BZ05-DV019');
  assert.match(url, /dodsbirsttr\.mil/);
});

test('DoD topics resolve by topic number into component, command, and phases', async () => {
  const db = await seedSources('dod', [
    { url: 'https://www.sbir.gov/topics/1', agency: 'DOW', topicNumber: 'OSW26BZ05-DV019', solicitation: '26.BZ' },
  ]);

  try {
    const result = await resolveTopics({ db, fetchImpl: createDodFetch(), delayMs: 0, sleep: noSleep });
    assert.strictEqual(result.resolved, 1);
    assert.strictEqual(result.skipped, 0);

    const rows = await allAsync(db, 'SELECT * FROM sbir_topic_details');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].component, 'OSD');
    assert.strictEqual(rows[0].command, 'RELIANCE 21');
    assert.strictEqual(rows[0].phase_hierarchy, 'I, II');
    assert.strictEqual(rows[0].sbir_topic_id, 1, 'detail links back to its source row');
  } finally {
    await closeAsync(db);
  }
});

test('attachments are extracted with filename and filetype', async () => {
  const db = await seedSources('attach', [
    { url: 'https://www.sbir.gov/topics/1', agency: 'DOW', topicNumber: 'OSW26BZ05-DV019' },
  ]);

  try {
    await resolveTopics({ db, fetchImpl: createDodFetch(), delayMs: 0, sleep: noSleep });
    const rows = await allAsync(db, 'SELECT attachments_json FROM sbir_topic_details');
    const attachments = JSON.parse(rows[0].attachments_json);

    assert.strictEqual(attachments.length, 2);
    assert.strictEqual(attachments[0].filename, 'R21_SBIR_26BZ_R5_v2.pdf');
    assert.strictEqual(attachments[0].filetype, 'pdf');
    assert.strictEqual(attachments[0].uploadId, 1838208);
    assert.strictEqual(attachments[1].filetype, 'docx');
  } finally {
    await closeAsync(db);
  }
});

test('a topic with no attachments stores null rather than an empty array', () => {
  assert.deepStrictEqual(dodAttachments({ baaInstructions: [] }), []);
  assert.deepStrictEqual(dodAttachments({}), []);
});

test('phase hierarchy flattens to display values', () => {
  assert.strictEqual(flattenPhaseHierarchy(DOD_TOPIC.phaseHierarchy), 'I, II');
  assert.strictEqual(flattenPhaseHierarchy('{"config":[]}'), null);
  assert.strictEqual(flattenPhaseHierarchy('not json'), null);
  assert.strictEqual(flattenPhaseHierarchy(null), null);
});

test('funding parsing extracts numbers and rejects unusable values', () => {
  assert.strictEqual(parseFunding('$150,000'), 150000);
  assert.strictEqual(parseFunding('150k'), 150000);
  assert.strictEqual(parseFunding('1.5M'), 1500000);
  assert.strictEqual(parseFunding(250000), 250000);
  assert.strictEqual(parseFunding('up to $75,000 per award'), 75000);
  assert.strictEqual(parseFunding('not specified'), null);
  assert.strictEqual(parseFunding(''), null);
  assert.strictEqual(parseFunding(null), null);
});

test('a topic number with no DoD match is skipped with a reason', async () => {
  const db = await seedSources('nomatch', [
    { url: 'https://www.sbir.gov/topics/1', agency: 'DOW', topicNumber: 'MISSING-123' },
  ]);

  try {
    const result = await resolveTopics({ db, fetchImpl: createDodFetch(), delayMs: 0, sleep: noSleep });
    assert.strictEqual(result.resolved, 0);
    assert.strictEqual(result.skipped, 1);
    assert.match(result.skippedSample[0].reason, /no DoD topic matched MISSING-123/);

    const rows = await allAsync(db, 'SELECT * FROM sbir_topic_details');
    assert.strictEqual(rows.length, 0, 'nothing is written for an unresolved topic');
  } finally {
    await closeAsync(db);
  }
});

test('agencies without a resolver are skipped without stopping the run', async () => {
  const db = await seedSources('mixed', [
    { url: 'https://www.sbir.gov/topics/1', agency: 'NSF', topicNumber: 'AV4' },
    { url: 'https://www.sbir.gov/topics/2', agency: 'DOW', topicNumber: 'OSW26BZ05-DV019' },
    { url: 'https://www.sbir.gov/topics/3', agency: 'HHS', topicNumber: 'PA-27-100' },
  ]);

  try {
    const result = await resolveTopics({ db, fetchImpl: createDodFetch(), delayMs: 0, sleep: noSleep });
    assert.strictEqual(result.candidates, 3);
    assert.strictEqual(result.resolved, 1, 'only DoD resolves today');
    assert.strictEqual(result.skipped, 2);
    assert.deepStrictEqual(result.skippedByAgency, { NSF: 1, HHS: 1 });
  } finally {
    await closeAsync(db);
  }
});

test('an upstream failure skips the topic instead of crashing the run', async () => {
  const db = await seedSources('failure', [
    { url: 'https://www.sbir.gov/topics/1', agency: 'DOW', topicNumber: 'OSW26BZ05-DV019' },
  ]);

  try {
    const result = await resolveTopics({
      db, fetchImpl: createDodFetch({ status: 503 }), delayMs: 0, sleep: noSleep,
    });
    assert.strictEqual(result.resolved, 0);
    assert.strictEqual(result.skipped, 1);
    assert.match(result.skippedSample[0].reason, /503/);
  } finally {
    await closeAsync(db);
  }
});

test('resolving twice is deterministic and does not duplicate details', async () => {
  const db = await seedSources('deterministic', [
    { url: 'https://www.sbir.gov/topics/1', agency: 'DOW', topicNumber: 'OSW26BZ05-DV019' },
  ]);

  try {
    await resolveTopics({ db, fetchImpl: createDodFetch(), delayMs: 0, sleep: noSleep });
    const first = await allAsync(db, 'SELECT sbir_topic_id, component, command, phase_hierarchy, attachments_json FROM sbir_topic_details ORDER BY sbir_topic_id');

    await resolveTopics({ db, fetchImpl: createDodFetch(), delayMs: 0, sleep: noSleep });
    const second = await allAsync(db, 'SELECT sbir_topic_id, component, command, phase_hierarchy, attachments_json FROM sbir_topic_details ORDER BY sbir_topic_id');

    assert.strictEqual(second.length, 1, 'no duplicate detail rows');
    assert.deepStrictEqual(second, first, 'output is stable across runs');
  } finally {
    await closeAsync(db);
  }
});

test('resolution can be scoped to one agency', async () => {
  const db = await seedSources('scoped', [
    { url: 'https://www.sbir.gov/topics/1', agency: 'NSF', topicNumber: 'AV4' },
    { url: 'https://www.sbir.gov/topics/2', agency: 'DOW', topicNumber: 'OSW26BZ05-DV019' },
  ]);

  try {
    const result = await resolveTopics({ db, fetchImpl: createDodFetch(), agency: 'DOW', delayMs: 0, sleep: noSleep });
    assert.strictEqual(result.candidates, 1);
    assert.strictEqual(result.resolved, 1);
  } finally {
    await closeAsync(db);
  }
});

test('deleting a source cascades to its detail row', async () => {
  const db = await seedSources('cascade', [
    { url: 'https://www.sbir.gov/topics/1', agency: 'DOW', topicNumber: 'OSW26BZ05-DV019' },
  ]);

  try {
    await resolveTopics({ db, fetchImpl: createDodFetch(), delayMs: 0, sleep: noSleep });
    await runAsync(db, 'PRAGMA foreign_keys = ON');
    await runAsync(db, 'DELETE FROM sbir_topic_sources WHERE id = 1');

    const rows = await allAsync(db, 'SELECT * FROM sbir_topic_details');
    assert.strictEqual(rows.length, 0, 'the detail row is removed with its source');
  } finally {
    await closeAsync(db);
  }
});
