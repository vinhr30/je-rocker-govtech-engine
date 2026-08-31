const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const worker = require('../grant_scraper/workers/simpler_browser_worker');
const { getSource } = require('../grant_scraper/lib/registry');
const { allAsync, withDatabase } = require('../grant_scraper/lib/db');
const { runNormalization } = require('../grant_scraper/pipeline/normalize');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'simpler-search-page.html'), 'utf8');

function tempDbPath(label) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `simpler-browser-${label}-`)), 'grants.db');
}

/** Minimal stand-in for a Playwright page so pagination is testable without a browser. */
function createFakePage(pages, { nextDisabledOnLast = true } = {}) {
  let index = 0;
  return {
    clicks: 0,
    async content() {
      return pages[index];
    },
    async $(selector) {
      if (selector !== '[data-testid="pagination-next"]') return null;
      const isLast = index >= pages.length - 1;
      return {
        isDisabled: async () => (nextDisabledOnLast ? isLast : false),
        click: async () => {
          this.clicks += 1;
          if (index < pages.length - 1) index += 1;
        },
      };
    },
  };
}

function pageWithNumbers(numbers) {
  const rows = numbers
    .map(
      (number, i) => `
      <tr>
        <td><div data-testid="responsive-header-${i}-0">Close date</div><p>Aug 31, 2026</p></td>
        <td><div data-testid="responsive-header-${i}-1">Status</div><div>Open</div></td>
        <td><div data-testid="responsive-header-${i}-2">Title</div>
          <a href="/opportunity/uuid-${number}">Title ${number}</a>
          <div><span class="text-bold">Number:</span> ${number}</div>
        </td>
        <td><div data-testid="responsive-header-${i}-3">Agency</div>
          <div>Test Agency<span>Posted date:</span> Aug 21, 2026 <span>Expected awards:</span> 2</div>
        </td>
        <td><div data-testid="responsive-header-${i}-4">Award min</div><p>$100</p></td>
        <td><div data-testid="responsive-header-${i}-5">Award max</div><p>$5,000</p></td>
      </tr>`,
    )
    .join('');
  return `<html><body><table><tbody>${rows}</tbody></table></body></html>`;
}

const noSleep = async () => {};

test('registry marks simpler_browser as a federal_primary browser list source', () => {
  const source = getSource('simpler_browser');
  assert.strictEqual(source.tier, 'federal_primary');
  assert.strictEqual(source.type, 'list');
  assert.strictEqual(source.sourceType, 'list');
  assert.strictEqual(source.ingestionMethod, 'browser');
  assert.strictEqual(source.method, 'browser');
  assert.strictEqual(source.baseUrl, 'https://simpler.grants.gov/search');
  assert.strictEqual(source.liveStatus, 'working');
  assert.strictEqual(source.cadence, 'daily');
});

test('DOM extraction pulls list fields from a saved search snapshot', () => {
  const rows = worker.parseSearchRows(FIXTURE);
  assert.strictEqual(rows.length, 3);

  const first = rows[0];
  assert.strictEqual(first.externalId, 'USDA-APHIS-10028-WSNWRC00-26-0018');
  assert.strictEqual(first.record.opportunityNumber, 'USDA-APHIS-10028-WSNWRC00-26-0018');
  assert.match(first.record.title, /^Spatial Ecology and Chronic Wasting Disease/);
  assert.strictEqual(first.record.agency, 'Animal and Plant Health Inspection Service');
  assert.strictEqual(first.record.deadline, '2026-08-31');
  assert.strictEqual(first.record.postedDate, '2026-08-21');
  assert.strictEqual(first.record.status, 'Open');
  assert.strictEqual(first.record.awardMin, 100);
  assert.strictEqual(first.record.awardMax, 413380);
  assert.strictEqual(first.record.ingestionMethod, 'browser');
  assert.strictEqual(
    first.url,
    'https://simpler.grants.gov/opportunity/0db7e64b-a7dd-45c7-b195-4982e924ec64',
    'detail page link is absolute',
  );
});

test('category and eligibility are null because the list view has no such columns', () => {
  for (const row of worker.parseSearchRows(FIXTURE)) {
    assert.strictEqual(row.record.category, null);
    assert.strictEqual(row.record.eligibility, null);
  }
});

test('rows without an opportunity number are skipped', () => {
  const html = '<table><tbody><tr><td><div data-testid="responsive-header-0-2">Title</div><a href="/opportunity/x">No number</a></td></tr></tbody></table>';
  assert.deepStrictEqual(worker.parseSearchRows(html), []);
});

test('pagination walks every page and dedupes across them', async () => {
  const page = createFakePage([
    pageWithNumbers(['OPP-1', 'OPP-2']),
    pageWithNumbers(['OPP-3', 'OPP-4']),
    pageWithNumbers(['OPP-5']),
  ]);

  const result = await worker.collectRecords(page, { maxPages: 10, settleMs: 0, sleep: noSleep });
  assert.strictEqual(result.pagesVisited, 3);
  assert.deepStrictEqual(
    result.records.map((r) => r.externalId),
    ['OPP-1', 'OPP-2', 'OPP-3', 'OPP-4', 'OPP-5'],
  );
});

test('pagination stops on a disabled Next button', async () => {
  const page = createFakePage([pageWithNumbers(['OPP-1'])]);
  const result = await worker.collectRecords(page, { maxPages: 10, settleMs: 0, sleep: noSleep });
  assert.strictEqual(result.pagesVisited, 1);
  assert.strictEqual(page.clicks, 0, 'a disabled Next is never clicked');
});

test('pagination cannot loop forever when Next stays enabled but content repeats', async () => {
  const page = createFakePage([pageWithNumbers(['OPP-1'])], { nextDisabledOnLast: false });
  const result = await worker.collectRecords(page, { maxPages: 50, settleMs: 0, sleep: noSleep });
  assert.strictEqual(result.pagesVisited, 1, 'unchanged first row halts the walk');
  assert.strictEqual(result.records.length, 1);
});

test('pagination honours the maxPages ceiling', async () => {
  const page = createFakePage(
    [pageWithNumbers(['A-1']), pageWithNumbers(['A-2']), pageWithNumbers(['A-3'])],
    { nextDisabledOnLast: false },
  );
  const result = await worker.collectRecords(page, { maxPages: 2, settleMs: 0, sleep: noSleep });
  assert.strictEqual(result.pagesVisited, 2);
});

test('worker writes browser rows into grants_raw with list and browser markers', async () => {
  const databasePath = tempDbPath('write');
  const browserFactory = async () => ({
    newPage: async () => ({
      goto: async () => {},
      waitForSelector: async () => {},
      content: async () => FIXTURE,
      $: async () => ({ isDisabled: async () => true, click: async () => {} }),
    }),
    close: async () => {},
  });

  const rows = await withDatabase(async (db) => {
    const result = await worker.run({ db, browserFactory, maxPages: 1, settleMs: 0, sleep: noSleep });
    assert.strictEqual(result.parsed, 3);
    assert.strictEqual(result.written, 3);
    return allAsync(db, 'SELECT source_id, source_type, ingestion_method, external_id, source_url FROM grants_raw ORDER BY external_id');
  }, databasePath);

  assert.strictEqual(rows.length, 3);
  for (const row of rows) {
    assert.strictEqual(row.source_id, 'simpler_browser');
    assert.strictEqual(row.source_type, 'list');
    assert.strictEqual(row.ingestion_method, 'browser');
    assert.match(row.source_url, /^https:\/\/simpler\.grants\.gov\/opportunity\//);
  }
});

test('normalization merges browser list rows with Grants.gov detail rows by opportunity number', async () => {
  const databasePath = tempDbPath('merge');
  const listRow = worker.parseSearchRows(FIXTURE)[0];
  const number = listRow.externalId;

  const merged = await withDatabase(async (db) => {
    await allAsync(db, 'SELECT 1');
    const { runAsync } = require('../grant_scraper/lib/db');
    await runAsync(
      db,
      `INSERT INTO grants_raw (source_id, source_name, category, source_type, ingestion_method, external_id, source_url, raw_json, fetched_at)
       VALUES ('simpler_browser','Simpler Grants.gov (Browser)','grants_gov','list','browser',?,?,?,'2026-01-01T00:00:00Z')`,
      [number, listRow.url, JSON.stringify(listRow.record)],
    );
    await runAsync(
      db,
      `INSERT INTO grants_raw (source_id, source_name, category, source_type, ingestion_method, external_id, source_url, raw_json, fetched_at)
       VALUES ('grants_gov_full','Grants.gov (Full)','grants_gov','detail','api',?,NULL,?,'2026-01-01T00:00:00Z')`,
      [
        number,
        JSON.stringify({
          opportunityNumber: number,
          owningAgencyCode: 'USDA-APHIS',
          synopsis: { awardFloor: '100', awardCeiling: '413380' },
          cfdas: [{ cfdaNumber: '10.028' }],
          opportunityCategory: { description: 'Discretionary' },
        }),
      ],
    );

    const result = await runNormalization(db);
    assert.strictEqual(result.failures.length, 0);
    return allAsync(db, 'SELECT * FROM grants_normalized');
  }, databasePath);

  assert.strictEqual(merged.length, 1, 'list and detail collapse into one row');
  const row = merged[0];
  assert.strictEqual(row.merge_key, `FED:${number.toUpperCase()}`);
  assert.ok(row.list_raw_id, 'list layer recorded');
  assert.ok(row.detail_raw_id, 'detail layer recorded');
  assert.strictEqual(row.source_id, 'simpler_browser', 'the primary list source owns the merged row');
  assert.match(row.title, /^Spatial Ecology/, 'list supplies the title');
  assert.strictEqual(row.agency, 'Animal and Plant Health Inspection Service', 'list supplies the agency');
  assert.strictEqual(row.agency_code, 'USDA-APHIS', 'detail supplies agency code');
  assert.strictEqual(row.cfda_numbers, '10.028', 'detail supplies CFDA');
  assert.strictEqual(row.opportunity_category, 'Discretionary', 'detail supplies category');
  assert.strictEqual(row.award_ceiling, 413380);
});

test('the detail worker resolves ids from the browser list layer', async () => {
  const databasePath = tempDbPath('detail-follows-list');
  const fullWorker = require('../grant_scraper/workers/grantsGovFull');
  const listRow = worker.parseSearchRows(FIXTURE)[0];

  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (url.includes('search2')) {
      assert.strictEqual(body.oppNum, listRow.externalId, 'lookup is by opportunity number');
      return { ok: true, status: 200, json: async () => ({ data: { oppHits: [{ id: '999', number: body.oppNum }] } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          id: body.opportunityId,
          opportunityNumber: listRow.externalId,
          cfdas: [{ cfdaNumber: '10.028' }],
          synopsis: { awardCeiling: '413380' },
        },
      }),
    };
  };

  const result = await withDatabase(async (db) => {
    const { runAsync } = require('../grant_scraper/lib/db');
    await runAsync(
      db,
      `INSERT INTO grants_raw (source_id, source_name, category, source_type, ingestion_method, external_id, source_url, raw_json, fetched_at)
       VALUES ('simpler_browser','Simpler Grants.gov (Browser)','grants_gov','list','browser',?,?,?,'2026-01-01T00:00:00Z')`,
      [listRow.externalId, listRow.url, JSON.stringify(listRow.record)],
    );
    return fullWorker.run({ db, fetchImpl, detailLimit: 5 });
  }, databasePath);

  assert.strictEqual(result.idSource, 'simpler_browser_list_layer');
  assert.strictEqual(result.written, 1);
});

test('repeated browser ingestion is idempotent and creates no duplicate grant ids', async () => {
  const databasePath = tempDbPath('idempotent');
  const browserFactory = async () => ({
    newPage: async () => ({
      goto: async () => {},
      waitForSelector: async () => {},
      content: async () => FIXTURE,
      $: async () => ({ isDisabled: async () => true, click: async () => {} }),
    }),
    close: async () => {},
  });

  const counts = await withDatabase(async (db) => {
    await worker.run({ db, browserFactory, maxPages: 1, settleMs: 0, sleep: noSleep });
    await runNormalization(db);
    await worker.run({ db, browserFactory, maxPages: 1, settleMs: 0, sleep: noSleep });
    await runNormalization(db);

    const raw = await allAsync(db, 'SELECT COUNT(*) AS n FROM grants_raw');
    const normalized = await allAsync(db, 'SELECT COUNT(*) AS n FROM grants_normalized');
    const dupes = await allAsync(
      db,
      'SELECT merge_key, COUNT(*) AS n FROM grants_normalized GROUP BY merge_key HAVING n > 1',
    );
    return { raw: raw[0].n, normalized: normalized[0].n, dupes: dupes.length };
  }, databasePath);

  assert.strictEqual(counts.raw, 3);
  assert.strictEqual(counts.normalized, 3);
  assert.strictEqual(counts.dupes, 0, 'no duplicate merge keys');
});
