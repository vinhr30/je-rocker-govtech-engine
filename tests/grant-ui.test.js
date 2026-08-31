const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { ensureSchema, openDatabase, runAsync, closeAsync } = require('../grant_scraper/lib/db');
const { listGrants, getGrantDetail, getGrantSignals, getSignalSets, scoreGrantForCompany, getCompanyProfile, WEIGHTS } = require('../src/grants/grants_service');
const { renderList, renderRow, buildListUrl } = require('../src/grants/grants_list');
const { renderDetail, renderSignals, toPlainText } = require('../src/grants/grants_detail');
const { seedCompanyProfile, JE_ROCKER } = require('../scripts/seed_company_profile');
const { seedBusinessDrivers, JE_ROCKER_DRIVERS } = require('../scripts/seed_business_drivers');

const GRANT = {
  agency: 'Animal and Plant Health Inspection Service',
  agency_code: 'USDA-APHIS',
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

  // Capability match only: no preferred agency.
  await runAsync(
    db,
    `INSERT INTO grants_normalized (
       merge_key, list_raw_id, source_id, category, external_id, title, agency,
       opportunity_number, status, close_date, url, normalized_at
     ) VALUES ('FED:CCC-3', 5, 'simpler_browser', 'grants_gov', 'CCC-3', 'Dashboard Intelligence Pilot',
       'Smithsonian Institution', 'CCC-3', 'Open', '2026-11-01', 'https://simpler.grants.gov/opportunity/ccc', '2026-08-31T00:00:00Z')`,
  );

  // Generic noise: matches nothing in the profile.
  await runAsync(
    db,
    `INSERT INTO grants_normalized (
       merge_key, list_raw_id, source_id, category, external_id, title, agency,
       opportunity_number, status, close_date, url, normalized_at
     ) VALUES ('FED:DDD-4', 7, 'simpler_browser', 'grants_gov', 'DDD-4', 'Community Theatre Outreach',
       'Smithsonian Institution', 'DDD-4', 'Open', '2026-12-01', 'https://simpler.grants.gov/opportunity/ddd', '2026-08-31T00:00:00Z')`,
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

async function seedCompanyDb(dir) {
  const databasePath = path.join(dir, 'company.db');
  await seedCompanyProfile(databasePath);
  return databasePath;
}

const TEST_DRIVERS = ['legacy modernization backlog', 'procurement cycle time'];
const TEST_CAPABILITY_MAP = [
  { capability: 'dashboard intelligence', terms: ['decision support dashboard'] },
];

async function seedDriverDb(dir) {
  const databasePath = path.join(dir, 'business_driver.db');
  await seedBusinessDrivers(databasePath, { drivers: TEST_DRIVERS, capabilityMap: TEST_CAPABILITY_MAP });
  return databasePath;
}

// Keeps list-shape tests independent of the seeded company profile.
const NO_COMPANY = { companyDatabasePath: '/tmp/grant-ui-no-company.db' };

test('list view returns Simpler-browser list fields only', async () => {
  const databasePath = await seedGrantsDb(tempDir('list'));
  const payload = await listGrants({ databasePath, ...NO_COMPANY });

  assert.strictEqual(payload.total, 4);
  assert.ok(
    !payload.grants.some((g) => g.oppNum === 'T-1'),
    'SBIR single-layer rows are excluded from the grant list',
  );
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

test('list view sorts by soonest deadline when unranked', async () => {
  const databasePath = await seedGrantsDb(tempDir('sort'));
  const payload = await listGrants({ databasePath, ...NO_COMPANY });
  assert.deepStrictEqual(payload.grants.map((g) => g.oppNum), ['AAA-1', 'BBB-2', 'CCC-3', 'DDD-4']);
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

test('JE ROCKER LC profile loads from company.db', async () => {
  const companyDatabasePath = await seedCompanyDb(tempDir('profile'));
  const profile = await getCompanyProfile({ companyDatabasePath });

  assert.strictEqual(profile.id, 'jerocker');
  assert.strictEqual(profile.name, 'JE ROCKER LC');
  assert.strictEqual(profile.type, 'primary_contractor');
  assert.deepStrictEqual(profile.capabilities, JE_ROCKER.capabilities);
  assert.deepStrictEqual(profile.focus_areas, JE_ROCKER.focus_areas);
  assert.deepStrictEqual(profile.preferred_agencies, JE_ROCKER.preferred_agencies);
  assert.deepStrictEqual(profile.modernization_signals, JE_ROCKER.modernization_signals);
});

test('a missing company profile leaves grants unranked rather than failing', async () => {
  const databasePath = await seedGrantsDb(tempDir('noprofile'));
  const payload = await listGrants({ databasePath, ...NO_COMPANY });

  assert.strictEqual(payload.company, null);
  assert.strictEqual(payload.ranked, false);
  assert.strictEqual(payload.grants[0].relevance, null);
  assert.strictEqual(payload.total, 4, 'all list-layer grants are still returned');
});

test('JE ROCKER scoring ranks agency above capability above generic noise', () => {
  const agencyMatch = scoreGrantForCompany(GRANT, JE_ROCKER);
  const capabilityMatch = scoreGrantForCompany(
    { agency: 'Smithsonian Institution', title: 'Dashboard Intelligence Pilot' },
    JE_ROCKER,
  );
  const noise = scoreGrantForCompany(
    { agency: 'Smithsonian Institution', title: 'Community Theatre Outreach' },
    JE_ROCKER,
  );

  assert.ok(agencyMatch.score > capabilityMatch.score, 'agency match outranks capability match');
  assert.ok(capabilityMatch.score > noise.score, 'capability match outranks generic noise');
  assert.strictEqual(noise.score, 0);

  assert.deepStrictEqual(agencyMatch.reasons.agency, ['usda'], 'agency code drives the match');
  assert.deepStrictEqual(capabilityMatch.reasons.capabilities, ['dashboard intelligence']);
});

test('signal sets load business drivers and capability map terms', async () => {
  const businessDriverDatabasePath = await seedDriverDb(tempDir('signals'));
  const signals = await getSignalSets({ businessDriverDatabasePath });

  assert.deepStrictEqual(signals.businessDrivers.sort(), [...TEST_DRIVERS].sort());
  assert.deepStrictEqual(signals.capabilityMapTerms, ['decision support dashboard']);
});

test('a missing business_driver.db contributes no signal rather than failing', async () => {
  const signals = await getSignalSets({ businessDriverDatabasePath: '/tmp/grant-ui-no-drivers.db' });
  assert.deepStrictEqual(signals, { businessDrivers: [], capabilityMapTerms: [] });
});

test('business drivers score at agency weight and land in score_business_driver', () => {
  const grant = { agency: 'Smithsonian Institution', title: 'Reducing procurement cycle time across bureaus' };
  const result = scoreGrantForCompany(grant, JE_ROCKER, {
    businessDrivers: TEST_DRIVERS,
    capabilityMapTerms: [],
  });

  assert.strictEqual(result.score_business_driver, WEIGHTS.businessDriver);
  assert.strictEqual(WEIGHTS.businessDriver, WEIGHTS.agency, 'business driver carries agency weight');
  assert.deepStrictEqual(result.reasons.businessDrivers, ['procurement cycle time']);
  assert.strictEqual(result.score_agency, 0);
});

test('capability map terms score on the capabilities axis', () => {
  const grant = { agency: 'Smithsonian Institution', title: 'Decision support dashboard for field teams' };
  const withoutMap = scoreGrantForCompany(grant, JE_ROCKER, { businessDrivers: [], capabilityMapTerms: [] });
  const withMap = scoreGrantForCompany(grant, JE_ROCKER, {
    businessDrivers: [],
    capabilityMapTerms: ['decision support dashboard'],
  });

  assert.strictEqual(withoutMap.score_capabilities, 0);
  assert.strictEqual(withMap.score_capabilities, WEIGHTS.capabilities);
  assert.strictEqual(withMap.score_business_driver, 0);
});

test('score_total is the sum of every cross-signal axis', () => {
  const grant = {
    agency: 'National Science Foundation',
    agency_code: 'NSF',
    title: 'Procurement cycle time and dashboard intelligence for automation',
    description: 'digital modernization of legacy system replacement',
  };
  const result = scoreGrantForCompany(grant, JE_ROCKER, {
    businessDrivers: TEST_DRIVERS,
    capabilityMapTerms: [],
  });

  const parts =
    result.score_agency +
    result.score_capabilities +
    result.score_focus_areas +
    result.score_modernization +
    result.score_business_driver;

  assert.strictEqual(result.score_total, parts);
  assert.strictEqual(result.score, result.score_total, 'score aliases score_total');
  assert.ok(result.score_agency > 0 && result.score_business_driver > 0 && result.score_capabilities > 0);
});

test('list rows carry the cross-signal breakdown', async () => {
  const dir = tempDir('breakdown');
  const databasePath = await seedGrantsDb(dir);
  const companyDatabasePath = await seedCompanyDb(dir);
  const businessDriverDatabasePath = await seedDriverDb(dir);

  const payload = await listGrants({ databasePath, companyDatabasePath, businessDriverDatabasePath });
  const first = payload.grants[0];

  for (const key of ['score_agency', 'score_capabilities', 'score_focus_areas', 'score_modernization', 'score_business_driver', 'score_total']) {
    assert.strictEqual(typeof first.relevance[key], 'number', `${key} is present`);
  }
});

test('grant signals endpoint reports every axis with weights and matches', async () => {
  const dir = tempDir('endpoint');
  const databasePath = await seedGrantsDb(dir);
  const companyDatabasePath = await seedCompanyDb(dir);
  const businessDriverDatabasePath = await seedDriverDb(dir);
  const opts = { databasePath, companyDatabasePath, businessDriverDatabasePath };

  const signals = await getGrantSignals('CCC-3', opts);
  assert.strictEqual(signals.oppNum, 'CCC-3');
  assert.strictEqual(signals.company.name, 'JE ROCKER LC');
  assert.deepStrictEqual(Object.keys(signals.scores).sort(), [
    'score_agency', 'score_business_driver', 'score_capabilities',
    'score_focus_areas', 'score_modernization', 'score_total',
  ]);
  assert.deepStrictEqual(signals.signals.map((s) => s.key), [
    'agency', 'business_driver', 'capabilities', 'focus_areas', 'modernization',
  ]);
  assert.strictEqual(signals.scores.score_capabilities, WEIGHTS.capabilities);
  assert.deepStrictEqual(
    signals.signals.find((s) => s.key === 'capabilities').matches,
    ['dashboard intelligence'],
  );

  assert.strictEqual(await getGrantSignals('NOPE', opts), null);
});

test('detail view renders the cross-signal breakdown', () => {
  const html = renderSignals({
    company: { id: 'jerocker', name: 'JE ROCKER LC' },
    scores: { score_total: 7 },
    signals: [
      { key: 'agency', label: 'Preferred agency', weight: 4, score: 4, matches: ['nsf'] },
      { key: 'business_driver', label: 'Business driver', weight: 4, score: 0, matches: [] },
      { key: 'capabilities', label: 'Capabilities', weight: 3, score: 3, matches: ['dashboard intelligence'] },
      { key: 'focus_areas', label: 'Focus areas', weight: 3, score: 0, matches: [] },
      { key: 'modernization', label: 'Modernization signals', weight: 2, score: 0, matches: [] },
    ],
  });

  assert.match(html, /Why this matches JE ROCKER LC/);
  assert.match(html, /Total relevance score: <strong>7<\/strong>/);
  for (const label of ['Preferred agency', 'Business driver', 'Capabilities', 'Focus areas', 'Modernization signals']) {
    assert.ok(html.includes(label), `missing signal: ${label}`);
  }
  assert.match(html, /dashboard intelligence/);
  assert.match(html, /no match/, 'unmatched axes are shown as zero');
  assert.strictEqual(renderSignals(null), '', 'absent signals render nothing');
});

test('the detail view includes the signal section when signals are supplied', () => {
  const grant = { oppNum: 'A', title: 'T', agency: 'A', hasDetail: true, fundingRange: {}, attachments: [] };
  const withSignals = renderDetail(grant, {
    company: { name: 'JE ROCKER LC' },
    scores: { score_total: 4 },
    signals: [{ key: 'agency', label: 'Preferred agency', weight: 4, score: 4, matches: ['nsf'] }],
  });

  assert.match(withSignals, /Why this matches JE ROCKER LC/);
  assert.ok(!renderDetail(grant).includes('Why this matches'), 'section is omitted without signals');
});

test('business drivers match modernization language inside the synopsis', () => {
  const drivers = ['improve data interoperability', 'reduce legacy system risk'];
  const grant = {
    agency: 'Smithsonian Institution',
    title: 'Regional Health Capacity Program',
    synopsis: '<p>Recipients must <b>improve data interoperability</b> across partner systems.</p>',
  };

  const result = scoreGrantForCompany(grant, JE_ROCKER, { businessDrivers: drivers, capabilityMapTerms: [] });
  assert.strictEqual(result.score_business_driver, WEIGHTS.businessDriver, 'synopsis text is scored');
  assert.deepStrictEqual(result.reasons.businessDrivers, ['improve data interoperability']);
});

test('synopsis markup does not break phrase matching', () => {
  const grant = {
    agency: 'Smithsonian Institution',
    title: 'Program',
    description: 'Agencies must <em>reduce</em> legacy system risk this cycle.',
  };
  const spanning = scoreGrantForCompany(grant, JE_ROCKER, {
    businessDrivers: ['legacy system risk'],
    capabilityMapTerms: [],
  });
  assert.strictEqual(spanning.score_business_driver, WEIGHTS.businessDriver, 'tags are stripped before matching');
});

test('description and synopsis are scored identically', () => {
  const drivers = ['deploy AI-driven analytics'];
  const text = 'The award will deploy AI-driven analytics for field staff.';
  const base = { agency: 'Smithsonian Institution', title: 'Program' };

  const viaDescription = scoreGrantForCompany({ ...base, description: text }, JE_ROCKER, { businessDrivers: drivers, capabilityMapTerms: [] });
  const viaSynopsis = scoreGrantForCompany({ ...base, synopsis: text }, JE_ROCKER, { businessDrivers: drivers, capabilityMapTerms: [] });

  assert.strictEqual(viaDescription.score_business_driver, WEIGHTS.businessDriver);
  assert.strictEqual(viaSynopsis.score_business_driver, viaDescription.score_business_driver);
});

test('title, category, and description still score without a synopsis', () => {
  const byTitle = scoreGrantForCompany(
    { agency: 'X', title: 'Accelerate digital modernization of case systems' },
    JE_ROCKER,
    { businessDrivers: ['accelerate digital modernization'], capabilityMapTerms: [] },
  );
  const byCategory = scoreGrantForCompany(
    { agency: 'X', title: 'Program', opportunity_category: 'dashboard intelligence' },
    JE_ROCKER,
    { businessDrivers: [], capabilityMapTerms: [] },
  );
  const byDescription = scoreGrantForCompany(
    { agency: 'X', title: 'Program', description: 'work to strengthen compliance and reporting' },
    JE_ROCKER,
    { businessDrivers: ['strengthen compliance and reporting'], capabilityMapTerms: [] },
  );

  assert.strictEqual(byTitle.score_business_driver, WEIGHTS.businessDriver, 'title still matches');
  assert.strictEqual(byCategory.score_capabilities, WEIGHTS.capabilities, 'category still matches');
  assert.strictEqual(byDescription.score_business_driver, WEIGHTS.businessDriver, 'description still matches');
});

test('a grant with no text scores zero on every axis', () => {
  const result = scoreGrantForCompany({ agency: 'Smithsonian Institution' }, JE_ROCKER, {
    businessDrivers: JE_ROCKER_DRIVERS,
    capabilityMapTerms: [],
  });
  assert.strictEqual(result.score_total, 0);
});

test('hyphenated words inside a phrase do not match on their own', () => {
  const driverHit = scoreGrantForCompany(
    { agency: 'State', title: 'Real-time coverage of human rights abuses' },
    JE_ROCKER,
    { businessDrivers: ['enable real-time operational visibility'], capabilityMapTerms: [] },
  );
  assert.strictEqual(driverHit.score_business_driver, 0, '"real-time" must not match on its own');

  const capabilityHit = scoreGrantForCompany(
    { agency: 'Labor', title: 'Brookwood-Sago high-risk mine safety grants' },
    JE_ROCKER,
    { businessDrivers: [], capabilityMapTerms: ['high-risk high-reward'] },
  );
  assert.strictEqual(capabilityHit.score_capabilities, 0, '"high-risk" must not match on its own');
});

test('short agency codes do not match ordinary words', () => {  const result = scoreGrantForCompany(
    { agency: 'Department of Commerce', title: 'Connecting the dots in rural broadband' },
    JE_ROCKER,
  );
  assert.deepStrictEqual(result.reasons.agency, [], '"DOT" must not match the word "dots"');
});

test('multi-word capabilities do not match on a single common word', () => {
  const result = scoreGrantForCompany(
    { agency: 'Smithsonian Institution', title: 'Open data for community museums' },
    JE_ROCKER,
  );
  assert.deepStrictEqual(result.reasons.capabilities, [], '"data ingestion pipelines" must not match on "data"');
});

test('the list is ranked by JE ROCKER relevance and returns every grant', async () => {
  const dir = tempDir('ranked');
  const databasePath = await seedGrantsDb(dir);
  const companyDatabasePath = await seedCompanyDb(dir);

  const payload = await listGrants({ databasePath, companyDatabasePath });

  assert.strictEqual(payload.ranked, true);
  assert.strictEqual(payload.company.name, 'JE ROCKER LC');
  assert.strictEqual(payload.total, 4, 'ranking never drops a grant');

  const order = payload.grants.map((g) => g.oppNum);
  assert.strictEqual(order[0], 'AAA-1', 'preferred agency ranks first');
  assert.strictEqual(order[1], 'CCC-3', 'capability match ranks second');

  const scores = payload.grants.map((g) => g.relevance.score);
  assert.deepStrictEqual([...scores].sort((a, b) => b - a), scores, 'scores are non-increasing');
  assert.strictEqual(scores[scores.length - 1], 0, 'generic noise ranks last');
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

  const ranked = renderList({
    grants: [{ oppNum: 'A', title: 'T', agency: 'A', href: '/grant/A', relevance: { score: 5 } }],
    company: { id: 'jerocker', name: 'JE ROCKER LC', type: 'primary_contractor' },
    total: 50,
    ranked: true,
  });
  assert.match(ranked, /Ranked by relevance to/);
  assert.match(ranked, /JE ROCKER LC/);
  assert.ok(!ranked.includes('No grants match'), 'the no-match message is gone');
  assert.ok(!ranked.includes('client'), 'no client wording remains');

  const empty = renderList({ grants: [] });
  assert.match(empty, /No grants have been ingested yet/);
  assert.ok(!empty.includes('No grants match'));
});

test('relevance badge is hidden when a grant scores zero', () => {
  const zero = renderRow({
    oppNum: 'A', title: 'T', agency: 'A', href: '/grant/A', relevance: { score: 0 },
  });
  assert.ok(!zero.includes('grant-row-score'), 'no badge for unscored grants');

  const scored = renderRow({
    oppNum: 'B', title: 'T', agency: 'A', href: '/grant/B', relevance: { score: 7 },
  });
  assert.match(scored, /match 7/);
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

test('list url carries only paging parameters', async () => {
  assert.strictEqual(buildListUrl(), '/api/grants');
  assert.strictEqual(buildListUrl({ limit: 10 }), '/api/grants?limit=10');
  assert.strictEqual(buildListUrl({ limit: 10, offset: 20 }), '/api/grants?limit=10&offset=20');
  assert.ok(!buildListUrl({ clientId: 7 }).includes('client'), 'client scoping is gone');
});
