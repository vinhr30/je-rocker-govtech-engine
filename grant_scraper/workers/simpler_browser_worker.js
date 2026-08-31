const { writeRecords } = require('./baseWorker');
const { getSource } = require('../lib/registry');
const { stripTags } = require('../lib/html');

const NEXT_SELECTOR = '[data-testid="pagination-next"]';
// The skeleton table renders before data, so wait on a real opportunity link.
const ROW_SELECTOR = 'table tbody tr a[href^="/opportunity/"]';
const BASE_ORIGIN = 'https://simpler.grants.gov';

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Simpler renders dates as "Aug 31, 2026". */
function toIsoDate(text) {
  if (!text) return null;
  const match = String(text).match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})/);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  return month ? `${match[3]}-${month}-${match[2].padStart(2, '0')}` : null;
}

function toAmount(text) {
  if (!text) return null;
  const digits = String(text).replace(/[^0-9.]/g, '');
  return digits ? Number(digits) : null;
}

function cellsOf(rowHtml) {
  return rowHtml.match(/<td[\s\S]*?<\/td>/gi) || [];
}

/**
 * Each cell carries a hidden responsive header naming its column, so cells are
 * keyed by that label instead of by position.
 */
function labelOf(cellHtml) {
  const match = cellHtml.match(/data-testid="responsive-header-\d+-\d+"[^>]*>([\s\S]*?)<\/div>/i);
  return match ? stripTags(match[1]).toLowerCase() : null;
}

function valueOf(cellHtml) {
  const withoutHeader = cellHtml.replace(
    /<div[^>]*data-testid="responsive-header-\d+-\d+"[^>]*>[\s\S]*?<\/div>/i,
    ' ',
  );
  return stripTags(withoutHeader);
}

function parseTitleCell(cellHtml) {
  const link = cellHtml.match(/href="(\/opportunity\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  const number = cellHtml.match(/Number:\s*<\/span>\s*([^<]+)/i);
  return {
    title: link ? stripTags(link[2]) : null,
    detailUrl: link ? `${BASE_ORIGIN}${link[1]}` : null,
    opportunityNumber: number ? stripTags(number[1]) : null,
  };
}

function parseAgencyCell(value) {
  const postedIndex = value.search(/Posted date\s*:/i);
  const agency = postedIndex >= 0 ? value.slice(0, postedIndex).trim() : value.trim();
  const posted = value.match(/Posted date\s*:\s*([A-Za-z]{3}[a-z]*\s+\d{1,2},\s*\d{4})/i);
  const awards = value.match(/Expected awards\s*:\s*([\d,]+)/i);
  return {
    agency: agency || null,
    postedDate: posted ? toIsoDate(posted[1]) : null,
    expectedAwards: awards ? Number(awards[1].replace(/,/g, '')) : null,
  };
}

/**
 * Parses the rendered search table. Category and eligibility are filter facets
 * on this page rather than columns, so they are left to the detail layer.
 */
function parseSearchRows(html) {
  const rows = String(html).match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const records = [];

  for (const rowHtml of rows) {
    const cells = cellsOf(rowHtml);
    if (!cells.length) continue;

    const byLabel = {};
    let titleCell = null;
    for (const cell of cells) {
      const label = labelOf(cell);
      if (!label) continue;
      byLabel[label] = valueOf(cell);
      if (label === 'title') titleCell = cell;
    }
    if (!titleCell) continue;

    const { title, detailUrl, opportunityNumber } = parseTitleCell(titleCell);
    if (!opportunityNumber) continue;

    const { agency, postedDate, expectedAwards } = parseAgencyCell(byLabel.agency || '');

    records.push({
      externalId: opportunityNumber,
      url: detailUrl,
      record: {
        opportunityNumber,
        title,
        agency,
        category: null,
        eligibility: null,
        deadline: toIsoDate(byLabel['close date']),
        status: byLabel.status || null,
        postedDate,
        expectedAwards,
        awardMin: toAmount(byLabel['award min']),
        awardMax: toAmount(byLabel['award max']),
        detailUrl,
        ingestionMethod: 'browser',
      },
    });
  }

  return records;
}

async function defaultBrowserFactory() {
  const { chromium } = require('playwright');
  return chromium.launch({ headless: true });
}

async function firstNumberOn(page) {
  const rows = parseSearchRows(await page.content());
  return rows.length ? rows[0].externalId : null;
}

/** Re-reads the page a few times so a mid-render skeleton is not mistaken for an empty result set. */
async function readRows(page, wait, settleMs, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows = parseSearchRows(await page.content());
    if (rows.length) return rows;
    if (attempt < attempts - 1) await wait(settleMs);
  }
  return [];
}

/**
 * Walks the paginated result set, stopping on a disabled Next button, an empty
 * page, or a page whose first row did not change after clicking.
 */
async function collectRecords(page, { maxPages, settleMs = 1500, sleep }) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const records = new Map();
  let pagesVisited = 0;

  while (pagesVisited < maxPages) {
    const rows = await readRows(page, wait, settleMs);
    if (!rows.length) break;

    for (const row of rows) records.set(row.externalId, row);
    pagesVisited += 1;

    const next = await page.$(NEXT_SELECTOR);
    if (!next) break;
    if (await next.isDisabled()) break;

    const before = rows[0].externalId;
    await next.click();
    await wait(settleMs);
    if ((await firstNumberOn(page)) === before) break;
  }

  return { records: [...records.values()], pagesVisited };
}

const source = getSource('simpler_browser');

module.exports = {
  id: source.id,
  source,
  parseSearchRows,
  collectRecords,

  async run({
    db,
    browserFactory = defaultBrowserFactory,
    maxPages = 5,
    settleMs,
    sleep,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!db) throw new Error(`Worker ${source.id} requires a database handle`);

    const browser = await browserFactory();
    let collected;
    try {
      const page = await browser.newPage();
      await page.goto(source.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector(ROW_SELECTOR, { timeout: 45000 });
      collected = await collectRecords(page, { maxPages, settleMs, sleep });
    } finally {
      await browser.close();
    }

    const fetchedAt = now();
    const written = await writeRecords(db, source, collected.records, fetchedAt);

    return {
      sourceId: source.id,
      category: source.category,
      pagesVisited: collected.pagesVisited,
      parsed: collected.records.length,
      written,
      fetchedAt,
    };
  },
};
