const path = require('path');
const { allAsync, runAsync, withSbirDatabase } = require('../grant_scraper/lib/db');

const BASE_URL = 'https://www.sbir.gov';
const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'sbir.db');
const USER_AGENT = 'je-rocker-sbir-harvester/1.0';

// The listing ends well before this; the guard only stops a runaway crawl.
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_DELAY_MS = 150;

const UPSERT_SOURCE = `
  INSERT INTO sbir_topic_sources (
    sbir_topic_url, official_url, title, agency, solicitation_number, topic_number, phase
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sbir_topic_url) DO UPDATE SET
    official_url = excluded.official_url,
    title = excluded.title,
    agency = excluded.agency,
    solicitation_number = excluded.solicitation_number,
    topic_number = excluded.topic_number,
    phase = excluded.phase
`;

function collapse(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html) {
  return collapse(String(html ?? '').replace(/<[^>]+>/g, ' '));
}

/** "Phase II" -> "II"; IIB and Fast-Track keep their own labels. */
function normalizePhase(value) {
  if (!value) return null;
  const text = String(value);
  if (/fast[\s-]?track/i.test(text)) return 'Fast-Track';

  const labelled = text.match(/phase\s+(iii|iib|ii|i)\b/i);
  if (labelled) return labelled[1].toUpperCase();

  const bare = collapse(text).match(/^(iii|iib|ii|i)$/i);
  return bare ? bare[1].toUpperCase() : null;
}

function listingUrl(page) {
  return `${BASE_URL}/topics?page=${page}`;
}

/** Topic cards link to /topics/<id>; ids repeat within a card, so they are deduped. */
function parseTopicLinks(html) {
  const ids = (String(html ?? '').match(/href="\/topics\/(\d+)"/g) || [])
    .map((match) => match.match(/\d+/)[0]);
  return [...new Set(ids)].map((id) => `${BASE_URL}/topics/${id}`);
}

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = String(html ?? '').match(pattern);
    if (match && collapse(match[1])) return collapse(match[1]);
  }
  return null;
}

function parseTopicDetail(html, sbirTopicUrl) {
  const source = String(html ?? '');

  const officialUrl = (source.match(/<a[^>]*href="([^"]+)"[^>]*>\s*View Official Solicitation/i) || [])[1] || null;
  const title = firstMatch(source, [
    /Back to Funding Opportunities Search<\/a><\/p>\s*<h2>([\s\S]*?)<\/h2>/i,
    /<h2>([\s\S]*?)<\/h2>/i,
  ]);

  const agencyBlock = source.match(/<h3>Funding Agency<\/h3>([\s\S]*?)<\/div>/i);
  const agencyParagraphs = agencyBlock
    ? [...agencyBlock[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1])).filter(Boolean)
    : [];

  const text = stripTags(source.replace(/<script[\s\S]*?<\/script>/gi, ''));

  const topicNumber = firstMatch(source, [/<strong>Topic Number:<\/strong>([^<]*)/i])
    || firstMatch(text, [/Topic Number:\s*([A-Z0-9][A-Z0-9.\-]+)/i]);
  const solicitationNumber = firstMatch(source, [/<strong>Solicitation Number:<\/strong>([^<]*)/i])
    || firstMatch(text, [/Solicitation Number:\s*([A-Z0-9][A-Z0-9.\-]+)/i]);

  return {
    sbirTopicUrl,
    officialUrl: officialUrl ? collapse(officialUrl) : null,
    title,
    agency: agencyParagraphs[0] || null,
    component: agencyParagraphs[1] || null,
    solicitationNumber,
    topicNumber,
    phase: normalizePhase(title) || normalizePhase(text.match(/phase\s+(?:iii|iib|ii|i)\b/i)?.[0]),
  };
}

async function fetchText(url, { fetchImpl, attempts = 3, sleep }) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
      if (response.ok) return response.text();
      // 429 and 5xx are transient; anything else will not improve on retry.
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`${url} returned ${response.status}`);
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (sleep) await sleep(250 * (attempt + 1));
  }
  throw lastError || new Error(`${url} failed`);
}

/**
 * Crawls the SBIR.gov topic listing, follows each topic page, and records the
 * authoritative "View Official Solicitation" URL for downstream ingestion.
 */
async function harvestTopics({
  db,
  fetchImpl = globalThis.fetch,
  maxPages = DEFAULT_MAX_PAGES,
  delayMs = DEFAULT_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  if (!db) throw new Error('harvestTopics requires a database handle');

  const seen = new Set();
  const skipped = [];
  let pagesFetched = 0;
  let written = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const listing = await fetchText(listingUrl(page), { fetchImpl, sleep });
    const topicUrls = parseTopicLinks(listing).filter((url) => !seen.has(url));
    const pageLinks = parseTopicLinks(listing);

    if (!pageLinks.length) break;
    pagesFetched += 1;

    let ingested = 0;
    for (const topicUrl of topicUrls) {
      seen.add(topicUrl);
      try {
        const detail = parseTopicDetail(await fetchText(topicUrl, { fetchImpl, sleep }), topicUrl);
        if (!detail.officialUrl) {
          skipped.push({ topicUrl, reason: 'no official solicitation link' });
          log(`[WARN] ${topicUrl}: no official solicitation link, skipped`);
          continue;
        }

        await runAsync(db, UPSERT_SOURCE, [
          detail.sbirTopicUrl,
          detail.officialUrl,
          detail.title,
          detail.agency,
          detail.solicitationNumber,
          detail.topicNumber,
          detail.phase,
        ]);
        written += 1;
        ingested += 1;
      } catch (error) {
        skipped.push({ topicUrl, reason: error.message });
        log(`[WARN] ${topicUrl}: ${error.message}`);
      }
      if (delayMs) await sleep(delayMs);
    }

    log(`[INFO] SBIR.gov page ${page}: ${ingested} topics ingested`);
  }

  return { pagesFetched, topicsSeen: seen.size, written, skipped: skipped.length, skippedSample: skipped.slice(0, 3) };
}

async function run({ databasePath = DEFAULT_DB_PATH, ...options } = {}) {
  return withSbirDatabase(async (db) => {
    const result = await harvestTopics({ db, ...options });
    const rows = await allAsync(db, 'SELECT COUNT(*) AS n FROM sbir_topic_sources');
    return { ...result, tableRows: rows[0].n };
  }, databasePath);
}

module.exports = {
  BASE_URL,
  DEFAULT_DB_PATH,
  harvestTopics,
  listingUrl,
  normalizePhase,
  parseTopicDetail,
  parseTopicLinks,
  run,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
  };
  const maxPages = getArg('--max-pages');

  run({
    maxPages: maxPages ? Number(maxPages) : DEFAULT_MAX_PAGES,
    log: (message) => console.log(message),
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
