const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureSbirSchema, openDatabase, closeAsync, allAsync } = require('../grant_scraper/lib/db');
const {
  harvestTopics,
  listingUrl,
  normalizePhase,
  parseTopicDetail,
  parseTopicLinks,
} = require('../sbir_scraper/sbir_topics_harvester');

const REAL_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sbir-topic-detail.html'), 'utf8');

const TOTAL_PAGES = 34;
const PER_PAGE = 10;
const noSleep = async () => {};

function tempDbPath(label) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `sbir-${label}-`)), 'sbir.db');
}

async function openTestDb(label) {
  const db = openDatabase(tempDbPath(label));
  await ensureSbirSchema(db);
  return db;
}

function listingHtml(page) {
  if (page >= TOTAL_PAGES) return '<html><body><p>No results</p></body></html>';
  const cards = Array.from({ length: PER_PAGE }, (_, i) => {
    const id = page * PER_PAGE + i + 1;
    // Real cards link the same id more than once; the parser must dedupe.
    return `<div class="card"><a href="/topics/${id}">Topic ${id}</a><a href="/topics/${id}">Read more</a></div>`;
  }).join('');
  return `<html><body>${cards}</body></html>`;
}

function detailHtml(id, overrides = {}) {
  const {
    title = `Topic ${id} Title`,
    agency = 'DOW',
    component = 'USAF',
    topicNumber = `DAF26BZ05-DV${String(id).padStart(3, '0')}`,
    solicitationNumber = '26.BZ',
    official = 'https://www.dodsbirsttr.mil/topics-app/',
  } = overrides;

  const officialAnchor = official
    ? `<a href="${official}" class="ext usa-button">View Official Solicitation</a>`
    : '<p>No official link published.</p>';

  return `<html><body>
    <p><a href="/topics?">Back to Funding Opportunities Search</a></p>
    <h2>${title}</h2>
    <div>
      <h3>Funding Agency</h3>
      <p class="margin-bottom-0">${agency}</p>
      <p class="margin-bottom-0"> ${component}</p>
    </div>
    <p><strong>Topic Number:</strong> ${topicNumber}</p>
    <p><strong>Solicitation Number:</strong> ${solicitationNumber}</p>
    ${officialAnchor}
  </body></html>`;
}

/** Serves a full 34-page listing plus topic detail pages. */
function createFakeFetch(options = {}) {
  const { detailOverrides = {}, failures = {}, calls = [] } = options;
  const attempts = new Map();

  return async (url) => {
    calls.push(url);
    const ok = (body) => ({ ok: true, status: 200, text: async () => body });

    const failure = failures[url];
    if (failure) {
      const seen = attempts.get(url) || 0;
      attempts.set(url, seen + 1);
      if (seen < failure.times) {
        return { ok: false, status: failure.status, text: async () => '' };
      }
    }

    const listing = url.match(/\/topics\?page=(\d+)$/);
    if (listing) return ok(listingHtml(Number(listing[1])));

    const detail = url.match(/\/topics\/(\d+)$/);
    if (detail) return ok(detailHtml(detail[1], detailOverrides[detail[1]] || {}));

    return { ok: false, status: 404, text: async () => '' };
  };
}

test('topic cards yield ten deduped detail urls per page', () => {
  const links = parseTopicLinks(listingHtml(0));
  assert.strictEqual(links.length, PER_PAGE, 'repeated links within a card collapse to one');
  assert.strictEqual(links[0], 'https://www.sbir.gov/topics/1');
  assert.ok(links.every((url) => /^https:\/\/www\.sbir\.gov\/topics\/\d+$/.test(url)));
  assert.deepStrictEqual(parseTopicLinks(listingHtml(TOTAL_PAGES)), [], 'an exhausted page yields none');
});

test('listing urls follow the SBIR.gov paging parameter', () => {
  assert.strictEqual(listingUrl(0), 'https://www.sbir.gov/topics?page=0');
  assert.strictEqual(listingUrl(33), 'https://www.sbir.gov/topics?page=33');
});

test('detail parsing extracts the official url and metadata from a real page', () => {
  const detail = parseTopicDetail(REAL_FIXTURE, 'https://www.sbir.gov/topics/12881');

  assert.strictEqual(detail.officialUrl, 'https://www.dodsbirsttr.mil/topics-app/');
  assert.strictEqual(detail.title, 'F-16 Agnostic Rapid Weapons Integration');
  assert.strictEqual(detail.agency, 'DOW');
  assert.strictEqual(detail.component, 'USAF');
  assert.strictEqual(detail.topicNumber, 'DAF26BZ05-DV031');
  assert.strictEqual(detail.solicitationNumber, '26.BZ');
});

test('phase normalization follows the agreed labels', () => {
  assert.strictEqual(normalizePhase('Phase I'), 'I');
  assert.strictEqual(normalizePhase('Phase II'), 'II');
  assert.strictEqual(normalizePhase('Phase III'), 'III');
  assert.strictEqual(normalizePhase('Phase IIB'), 'IIB');
  assert.strictEqual(normalizePhase('IIB'), 'IIB');
  assert.strictEqual(normalizePhase('Fast-Track'), 'Fast-Track');
  assert.strictEqual(normalizePhase('fast track'), 'Fast-Track');
  assert.strictEqual(normalizePhase('DIRECT TO PHASE II: Intelligent Systems'), 'II');
  assert.strictEqual(normalizePhase('no phase here'), null);
  assert.strictEqual(normalizePhase(null), null);
});

test('text fields are trimmed and collapsed', () => {
  const detail = parseTopicDetail(
    detailHtml('7', { title: '  Spaced   \n  Title  ' }),
    'https://www.sbir.gov/topics/7',
  );
  assert.strictEqual(detail.title, 'Spaced Title');
});

/**
 * Mirrors the live listing, where pagination is not stably sorted and every page
 * after the first repeats one topic from the previous page: 337 raw links, 304 unique.
 */
function overlappingListingHtml(page) {
  if (page >= TOTAL_PAGES) return '<html><body><p>No results</p></body></html>';

  const isLast = page === TOTAL_PAGES - 1;
  const newCount = page === 0 ? PER_PAGE : (isLast ? 6 : PER_PAGE - 1);
  const firstId = page === 0 ? 1 : PER_PAGE + (page - 1) * (PER_PAGE - 1) + 1;

  const ids = Array.from({ length: newCount }, (_, i) => firstId + i);
  if (page > 0) ids.unshift(firstId - 1);

  return `<html><body>${ids.map((id) => `<div class="card"><a href="/topics/${id}">Topic ${id}</a></div>`).join('')}</body></html>`;
}

function createOverlappingFetch() {
  return async (url) => {
    const ok = (body) => ({ ok: true, status: 200, text: async () => body });
    const listing = url.match(/\/topics\?page=(\d+)$/);
    if (listing) return ok(overlappingListingHtml(Number(listing[1])));
    const detail = url.match(/\/topics\/(\d+)$/);
    if (detail) return ok(detailHtml(detail[1]));
    return { ok: false, status: 404, text: async () => '' };
  };
}

test('the listing serves 337 raw links across its pages', () => {
  let raw = 0;
  for (let page = 0; page < TOTAL_PAGES; page += 1) raw += parseTopicLinks(overlappingListingHtml(page)).length;
  assert.strictEqual(raw, 337, 'matches the raw link count seen live');
});

test('topics repeated across pages are deduplicated to 304 unique', async () => {
  const db = await openTestDb('crosspage');
  try {
    const result = await harvestTopics({
      db, fetchImpl: createOverlappingFetch(), delayMs: 0, sleep: noSleep,
    });

    assert.strictEqual(result.pagesFetched, TOTAL_PAGES);
    assert.strictEqual(result.topicsSeen, 304, '337 raw links collapse to 304 unique topics');
    assert.strictEqual(result.written, 304);

    const rows = await allAsync(db, 'SELECT COUNT(*) AS total, COUNT(DISTINCT sbir_topic_url) AS unique_urls FROM sbir_topic_sources');
    assert.strictEqual(rows[0].total, 304);
    assert.strictEqual(rows[0].unique_urls, 304, 'no duplicate rows reached the table');
  } finally {
    await closeAsync(db);
  }
});

test('a repeated topic is only fetched once', async () => {
  const db = await openTestDb('fetchonce');
  const calls = [];
  const base = createOverlappingFetch();
  try {
    await harvestTopics({
      db,
      fetchImpl: async (url) => { calls.push(url); return base(url); },
      maxPages: 3,
      delayMs: 0,
      sleep: noSleep,
    });

    const detailCalls = calls.filter((url) => /\/topics\/\d+$/.test(url));
    assert.strictEqual(detailCalls.length, new Set(detailCalls).size, 'no topic page is fetched twice');
  } finally {
    await closeAsync(db);
  }
});

test('BOTH is a program tag, not a phase', () => {
  assert.strictEqual(normalizePhase('BOTH'), null);
  assert.strictEqual(normalizePhase('SBIR'), null);
  assert.strictEqual(normalizePhase('STTR'), null);

  const detail = parseTopicDetail(
    detailHtml('9', { title: 'Autonomous Sensing Topic' }).replace(
      '<h3>Funding Agency</h3>',
      '<p>BOTH</p><h3>Funding Agency</h3>',
    ),
    'https://www.sbir.gov/topics/9',
  );
  assert.strictEqual(detail.phase, null, 'a BOTH-tagged topic has no phase');
});

test('the harvester walks every page and stops when the listing runs out', async () => {
  const db = await openTestDb('pagination');
  const calls = [];
  try {
    const result = await harvestTopics({
      db, fetchImpl: createFakeFetch({ calls }), delayMs: 0, sleep: noSleep,
    });

    assert.strictEqual(result.pagesFetched, TOTAL_PAGES, '34 pages of topics');
    assert.strictEqual(result.topicsSeen, TOTAL_PAGES * PER_PAGE);
    assert.strictEqual(result.written, TOTAL_PAGES * PER_PAGE);

    const listingCalls = calls.filter((url) => /\?page=/.test(url));
    assert.strictEqual(listingCalls.length, TOTAL_PAGES + 1, 'one extra fetch detects the empty page');
    assert.ok(listingCalls.includes(listingUrl(33)));
  } finally {
    await closeAsync(db);
  }
});

test('the max page guard stops a runaway crawl', async () => {
  const db = await openTestDb('guard');
  try {
    const result = await harvestTopics({
      db, fetchImpl: createFakeFetch(), maxPages: 3, delayMs: 0, sleep: noSleep,
    });
    assert.strictEqual(result.pagesFetched, 3);
    assert.strictEqual(result.written, 3 * PER_PAGE);
  } finally {
    await closeAsync(db);
  }
});

test('rows carry the harvested metadata', async () => {
  const db = await openTestDb('rows');
  try {
    await harvestTopics({ db, fetchImpl: createFakeFetch(), maxPages: 1, delayMs: 0, sleep: noSleep });
    const rows = await allAsync(db, 'SELECT * FROM sbir_topic_sources ORDER BY id LIMIT 1');

    assert.strictEqual(rows[0].sbir_topic_url, 'https://www.sbir.gov/topics/1');
    assert.strictEqual(rows[0].official_url, 'https://www.dodsbirsttr.mil/topics-app/');
    assert.strictEqual(rows[0].agency, 'DOW');
    assert.strictEqual(rows[0].topic_number, 'DAF26BZ05-DV001');
    assert.strictEqual(rows[0].solicitation_number, '26.BZ');
    assert.ok(rows[0].created_at, 'created_at is stamped');
  } finally {
    await closeAsync(db);
  }
});

test('a topic without an official solicitation link is skipped with a warning', async () => {
  const db = await openTestDb('skip');
  const warnings = [];
  try {
    const result = await harvestTopics({
      db,
      fetchImpl: createFakeFetch({ detailOverrides: { 3: { official: null } } }),
      maxPages: 1,
      delayMs: 0,
      sleep: noSleep,
      log: (message) => warnings.push(message),
    });

    assert.strictEqual(result.written, PER_PAGE - 1);
    assert.strictEqual(result.skipped, 1);
    assert.match(result.skippedSample[0].reason, /no official solicitation link/);
    assert.ok(warnings.some((w) => /WARN.*topics\/3/.test(w)), 'the skip is logged');

    const rows = await allAsync(db, 'SELECT sbir_topic_url FROM sbir_topic_sources');
    assert.ok(!rows.some((r) => r.sbir_topic_url.endsWith('/3')), 'the skipped topic is not stored');
  } finally {
    await closeAsync(db);
  }
});

test('running the harvester twice does not duplicate rows', async () => {
  const db = await openTestDb('deterministic');
  try {
    const first = await harvestTopics({ db, fetchImpl: createFakeFetch(), maxPages: 2, delayMs: 0, sleep: noSleep });
    const firstRows = await allAsync(db, 'SELECT sbir_topic_url, official_url, topic_number FROM sbir_topic_sources ORDER BY sbir_topic_url');

    const second = await harvestTopics({ db, fetchImpl: createFakeFetch(), maxPages: 2, delayMs: 0, sleep: noSleep });
    const secondRows = await allAsync(db, 'SELECT sbir_topic_url, official_url, topic_number FROM sbir_topic_sources ORDER BY sbir_topic_url');

    assert.strictEqual(first.written, second.written);
    assert.strictEqual(secondRows.length, firstRows.length, 'no duplicate rows on re-run');
    assert.deepStrictEqual(secondRows, firstRows, 'output is deterministic across runs');
  } finally {
    await closeAsync(db);
  }
});

test('transient 429 and 500 responses are retried', async () => {
  const db = await openTestDb('retry');
  const calls = [];
  const failures = {
    'https://www.sbir.gov/topics/1': { status: 500, times: 2 },
    'https://www.sbir.gov/topics/2': { status: 429, times: 1 },
  };

  try {
    const result = await harvestTopics({
      db, fetchImpl: createFakeFetch({ failures, calls }), maxPages: 1, delayMs: 0, sleep: noSleep,
    });

    assert.strictEqual(result.written, PER_PAGE, 'both topics recover after retrying');
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(calls.filter((u) => u.endsWith('/topics/1')).length, 3, '500 retried twice');
    assert.strictEqual(calls.filter((u) => u.endsWith('/topics/2')).length, 2, '429 retried once');
  } finally {
    await closeAsync(db);
  }
});

test('a persistently failing topic is skipped without stopping the crawl', async () => {
  const db = await openTestDb('persistent');
  try {
    const result = await harvestTopics({
      db,
      fetchImpl: createFakeFetch({ failures: { 'https://www.sbir.gov/topics/4': { status: 500, times: 99 } } }),
      maxPages: 1,
      delayMs: 0,
      sleep: noSleep,
    });

    assert.strictEqual(result.written, PER_PAGE - 1, 'the rest of the page still ingests');
    assert.strictEqual(result.skipped, 1);
    assert.match(result.skippedSample[0].reason, /500/);
  } finally {
    await closeAsync(db);
  }
});

test('a malformed detail page is skipped rather than crashing the run', async () => {
  const db = await openTestDb('malformed');
  const fetchImpl = async (url) => {
    if (/\?page=/.test(url)) return { ok: true, status: 200, text: async () => listingHtml(Number(url.match(/page=(\d+)/)[1])) };
    if (url.endsWith('/topics/5')) return { ok: true, status: 200, text: async () => '<html><body><h2>Broken' };
    return { ok: true, status: 200, text: async () => detailHtml(url.match(/\d+$/)[0]) };
  };

  const result = await harvestTopics({ db, fetchImpl, maxPages: 1, delayMs: 0, sleep: noSleep });
  assert.strictEqual(result.written, PER_PAGE - 1);
  assert.strictEqual(result.skipped, 1);
  await closeAsync(db);
});
