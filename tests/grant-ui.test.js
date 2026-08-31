const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { ensureSchema, openDatabase, runAsync, closeAsync } = require('../grant_scraper/lib/db');
const { listGrants, getGrantDetail, scoreGrantForClient } = require('../src/grants/grants_service');
const { renderList, renderRow, buildListUrl } = require('../src/grants/grants_list');
const { renderDetail, toPlainText } = require('../src/grants/grants_detail');

const GRANT = {
  agency: 'Animal and Plant Health Inspection Service',
  title: 'Chronic Wasting Disease Surveillance',
  opportunity_category: 'Discretionary',
  description: 'wildlife disease surveillance',
  applicant_types: 'Public and State controlled institutions of higher education',
};

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `grant-ui-${label}-`));
}

async function seedGrantsDb(dir) {
  const databasePath = path.join(dir, 'grants.db');
  const db = openDatabase(databasePath);
  await ensureSchema(db);

  await runAsync(
    db,
    `INSERT INTO grants_normalized (
       merge_key, list_raw_id, detail_raw_id, source_id, category, external_id, title, agency,
       agency_code, opportunity_number, status, posted_date, close_date, award_floor, award_ceiling,
       estimated_funding, cfda_numbers, applicant_types, opportunity_category, attachments,
       url, description, normalized_at
     ) VALUES ('FED:AAA-1', 1, 2, 'simpler_browser', 'grants_gov', 'AAA-1', ?, ?, 'USDA-APHIS',
       'AAA-1', 'Open', '2026-08-01', '2026-09-30', 100, 413380, 413380, '10.028', ?, 'Discretionary',
       '[{"name":"nofo.pdf","description":"Full announcement"}]',
       'https://simpler.grants.gov/opportunity/aaa', ?, '2026-08-31T00:00:00Z')`,
    [GRANT.title, GRANT.agency, GRANT.applicant_types, '<p>Wildlife <b>disease</b> surveillance.</p>'],
  );

  // List layer only: no detail ingested yet.
  await runAsync(
    db,
    `INSERT INTO grants_normalized (
       merge_key, list_raw_id, source_id, category, external_id, title, agency,
       opportunity_number, status, close_date, url, normalized_at
     ) VALUES ('FED:BBB-2', 3, 'simpler_browser', 'grants_gov', 'BBB-2', 'Coastal Resilience Grant',
       'NOAA', 'BBB-2', 'Open', '2026-10-15', 'https://simpler.grants.gov/opportunity/bbb', '2026-08-31T00:00:00Z')`,
  );

  // Not a list-layer row; must never appear in the list view.
  await runAsync(
    db,
    `INSERT INTO grants_normalized (merge_key, raw_id, source_id, category, external_id,
       title, agency, opportunity_number, normalized_at)
     VALUES ('dod_sbir:T-1', 9, 'dod_sbir', 'sbir', 'T-1', 'Edge Autonomy', 'ARMY', 'T-1', '2026-08-31T00:00:00Z')`,
  );

  await closeAsync(db);
  return databasePath;
}

function seedClientDb(dir, client) {
  const databasePath = path.join(dir, 'client.db');
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(databasePath);
    db.serialize(() => {
      db.run(`CREATE TABLE clients (
        client_id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name TEXT, keywords TEXT, preferred_agencies TEXT
      )`);
      db.run(
        'INSERT INTO clients (client_name, keywords, preferred_agencies) VALUES (?, ?, ?)',
        [client.name, client.keywords, client.agencies],
        (err) => (err ? reject(err) : db.close(() => resolve(databasePath))),
      );
    });
  });
}

test('list view returns Simpler-browser list fields only', async () => {
  const databasePath = await seedGrantsDb(tempDir('list'));
  const payload = await listGrants({ databasePath });

  assert.strictEqual(payload.total, 2, 'SBIR single-layer rows are excluded from the grant list');
  const [first] = payload.grants;
  assert.deepStrictEqual(Object.keys(first).sort(), [
    'agency', 'awardMax', 'awardMin', 'deadline', 'href', 'oppNum', 'postedDate', 'relevance', 'status', 'title', 'url',
  ]);
  assert.strictEqual(first.oppNum, 'AAA-1');
  assert.strictEqual(first.agency, GRANT.agency);
  assert.strictEqual(first.deadline, '2026-09-30');
  assert.strictEqual(first.status, 'Open');
  assert.strictEqual(first.awardMin, 100);
  assert.strictEqual(first.awardMax, 413380);
  assert.strictEqual(first.href, '/grant/AAA-1');
});

test('list view sorts by soonest deadline', async () => {
  const databasePath = await seedGrantsDb(tempDir('sort'));
  const payload = await listGrants({ databasePath });
  assert.deepStrictEqual(payload.grants.map((g) => g.oppNum), ['AAA-1', 'BBB-2']);
});

test('detail view returns Grants.gov full fields', async () => {
  const databasePath = await seedGrantsDb(tempDir('detail'));
  const grant = await getGrantDetail('AAA-1', { databasePath });

  assert.strictEqual(grant.hasDetail, true);
  assert.strictEqual(grant.cfda, '10.028');
  assert.strictEqual(grant.opportunityCategory, 'Discretionary');
  assert.strictEqual(grant.applicantTypes, GRANT.applicant_types);
  assert.deepStrictEqual(grant.fundingRange, { awardFloor: 100, awardCeiling: 413380, estimatedFunding: 413380 });
  assert.strictEqual(grant.attachments.length, 1);
  assert.strictEqual(grant.attachments[0].name, 'nofo.pdf');
});

test('detail view flags rows that have no detail layer yet', async () => {
  const databasePath = await seedGrantsDb(tempDir('nodetail'));
  const grant = await getGrantDetail('BBB-2', { databasePath });
  assert.strictEqual(grant.hasDetail, false);
  assert.strictEqual(grant.cfda, null);
});

test('unknown opportunity numbers resolve to null', async () => {
  const databasePath = await seedGrantsDb(tempDir('missing'));
  assert.strictEqual(await getGrantDetail('NOPE', { databasePath }), null);
});

test('client relevance matches on agency, category, and eligibility', () => {
  const cases = [
    [{ preferred_agencies: 'Animal and Plant Health Inspection Service' }, 'agency'],
    [{ capability_signals: 'wildlife disease surveillance' }, 'category'],
    [{ business_classifications: 'institutions of higher education' }, 'eligibility'],
  ];

  for (const [client, axis] of cases) {
    const result = scoreGrantForClient(GRANT, client);
    assert.strictEqual(result.matched, true, `${axis} should match`);
    assert.ok(result.reasons[axis].length > 0, `${axis} should report why`);
  }
});

test('generic procurement vocabulary does not create false matches', () => {
  for (const keywords of ['program management, department support', 'federal services, national office']) {
    const result = scoreGrantForClient(GRANT, { keywords });
    assert.strictEqual(result.matched, false, `"${keywords}" must not match`);
    assert.strictEqual(result.score, 0);
  }
});

test('unrelated capabilities do not match', () => {
  const result = scoreGrantForClient(GRANT, { keywords: 'cloud migration, cybersecurity' });
  assert.strictEqual(result.matched, false);
});

test('no client means no filtering', async () => {
  const databasePath = await seedGrantsDb(tempDir('noclient'));
  const payload = await listGrants({ databasePath });
  assert.strictEqual(payload.clientId, null);
  assert.strictEqual(payload.grants[0].relevance, null);
});

test('selecting a client filters the list and reports the unfiltered total', async () => {
  const dir = tempDir('client');
  const databasePath = await seedGrantsDb(dir);
  const clientDatabasePath = await seedClientDb(dir, {
    name: 'Wildlife Analytics',
    keywords: 'wildlife disease surveillance',
    agencies: '',
  });

  const payload = await listGrants({ databasePath, clientDatabasePath, clientId: 1 });
  assert.strictEqual(payload.clientName, 'Wildlife Analytics');
  assert.strictEqual(payload.unfilteredTotal, 2);
  assert.strictEqual(payload.total, 1, 'only the relevant grant survives the filter');
  assert.strictEqual(payload.grants[0].oppNum, 'AAA-1');
  assert.ok(payload.grants[0].relevance.score > 0);
});

test('list module renders the six required row fields', async () => {
  const html = renderRow({
    oppNum: 'AAA-1', title: 'Chronic Wasting Disease', agency: 'APHIS',
    deadline: '2026-09-30', status: 'Open', awardMin: 100, awardMax: 413380,
    href: '/grant/AAA-1', relevance: null,
  });

  assert.match(html, /Chronic Wasting Disease/);
  assert.match(html, /APHIS/);
  assert.match(html, /Sep 30, 2026/);
  assert.match(html, />Open</);
  assert.match(html, /\$100/);
  assert.match(html, /\$413,380/);
  assert.match(html, /href="\/grant\/AAA-1"/, 'row links to the detail page');

  const empty = renderList({ grants: [], clientName: 'Acme', unfilteredTotal: 50 });
  assert.match(empty, /No grants match/);
  assert.match(empty, /50 open opportunities/);
});

test('list module escapes untrusted grant text', async () => {
  const html = renderRow({
    oppNum: 'X', title: '<img src=x onerror="alert(1)">', agency: '"><script>alert(2)</script>',
    deadline: null, status: null, awardMin: null, awardMax: null, href: '/grant/X', relevance: null,
  });

  assert.ok(!html.includes('<img'), 'raw markup must not survive');
  assert.ok(!html.includes('<script>'), 'script tags must not survive');
  assert.match(html, /&lt;img/);
});

test('detail module renders every required field and a back link', async () => {
  const html = renderDetail({
    oppNum: 'AAA-1', title: 'Chronic Wasting Disease', agency: 'APHIS', hasDetail: true,
    synopsis: '<p>Wildlife <b>disease</b> surveillance.</p>',
    applicantTypes: 'Higher education', opportunityCategory: 'Discretionary', cfda: '10.028',
    fundingRange: { awardFloor: 100, awardCeiling: 413380, estimatedFunding: 413380 },
    attachments: [{ name: 'nofo.pdf', description: 'Full announcement' }],
    deadline: '2026-09-30', url: 'https://example.test/a',
  });

  for (const label of ['Synopsis', 'Applicant types', 'Opportunity category', 'CFDA', 'Funding range', 'Attachments']) {
    assert.ok(html.includes(label), `missing field: ${label}`);
  }
  assert.match(html, /data-action="back"/, 'back button returns to the list');
  assert.match(html, /nofo\.pdf/);
  assert.match(html, /Wildlife disease surveillance\./, 'synopsis HTML is flattened to text');
  assert.ok(!html.includes('<b>'), 'source markup is not injected');
  assert.strictEqual(toPlainText('<p>a</p><p>b</p>'), 'a\n\nb');
});

test('detail module reports missing grants and missing detail layers', async () => {
  assert.match(renderDetail(null), /Grant not found/);

  const pending = renderDetail({
    oppNum: 'BBB-2', title: 'Coastal', agency: 'NOAA', hasDetail: false,
    fundingRange: {}, attachments: [],
  });
  assert.match(pending, /Detail layer has not been ingested/);
  assert.match(pending, /No attachments published/);
});

test('list url carries the selected client', async () => {
  assert.strictEqual(buildListUrl(), '/api/grants');
  assert.strictEqual(buildListUrl({ clientId: 7 }), '/api/grants?client_id=7');
  assert.strictEqual(buildListUrl({ clientId: 7, limit: 10 }), '/api/grants?client_id=7&limit=10');
});
