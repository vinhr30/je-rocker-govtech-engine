const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { createClient, clientEvents } = require('./src/utils/db');
const { listGrants, getGrantDetail, getGrantSignals } = require('./src/grants/grants_service');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

const fpds = new sqlite3.Database('./db/fpds.db');
const opp = new sqlite3.Database('./db/opportunities.db');
const matches = new sqlite3.Database('./db/matches.db');
const clientDb = new sqlite3.Database('./client.db');
const PIPELINE_ROOT = process.env.JE_ROCKER_PIPELINE_ROOT || '/Volumes/Data Drive/Govtech/JE ROCKER';

app.use(express.json());
app.use(express.static(__dirname));

clientEvents.on('onClientCreated', (client) => {
  console.info(`[client] created pending client ${client.id}`);
});

clientDb.serialize(() => {
  clientDb.run(`
    CREATE TABLE IF NOT EXISTS clients (
      client_id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT,
      uei TEXT,
      duns TEXT,
      naics TEXT,
      keywords TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      preferred_agencies TEXT,
      past_performance TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  clientDb.get('SELECT COUNT(*) AS count FROM clients', (countErr, row) => {
    if (countErr) {
      console.error('[clientDb] failed to read clients count:', countErr.message);
      return;
    }

    if (Number(row?.count || 0) > 0) {
      return;
    }

    const insertSql = `
      INSERT INTO clients (
        client_name, uei, duns, naics, keywords,
        contact_name, contact_email, contact_phone,
        preferred_agencies, past_performance, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const dummyClients = [
      [
        'Atlas Federal Services',
        'ATLASFED12345',
        '123456789',
        '541519,541611,561210',
        'IT modernization, cloud migration, program management',
        'Jordan Miles',
        'jmiles@atlasfederal.com',
        '(202) 555-0110',
        'Department of Defense; VA; DHS',
        'Prime support on enterprise modernization and service desk delivery.',
        'Strong incumbent displacement strategy with agile delivery emphasis.'
      ],
      [
        'Northline Consulting Group',
        'NORTHLINE67890',
        '987654321',
        '541330,541512,541690',
        'engineering analytics, mission support, technical integration',
        'Casey Nguyen',
        'cnguyen@northlinecg.com',
        '(703) 555-0142',
        'USAF; Navy; GSA',
        'Sub and prime roles across technical studies and systems integration.',
        'Focus on recompete captures with teaming partner optionality.'
      ],
      [
        'Blue Harbor Solutions',
        'BLUEHARBOR2468',
        '246813579',
        '561110,541618,541611',
        'operations support, acquisition advisory, process optimization',
        'Alex Rivera',
        'arivera@blueharborsolutions.com',
        '(571) 555-0197',
        'HHS; USDA; Department of State',
        'Operational improvement and acquisition support across civilian agencies.',
        'Best fit for service contracts with structured transition requirements.'
      ],
    ];

    dummyClients.forEach((record) => {
      clientDb.run(insertSql, record, (insertErr) => {
        if (insertErr) {
          console.error('[clientDb] failed to insert dummy client:', insertErr.message);
        }
      });
    });
  });
});

const PSC_SUPPRESS = new Set(['S200', 'S201', 'S202', 'S203', 'S204', 'S205', 'S206', 'S207']);
const NAICS_SUPPRESS = new Set(['236220', '237110', '238220', '561210', '561720']);
const TITLE_SUPPRESS_RE = /(repair|maintenance|facility|construction|civil|grounds|janitorial|hvac)/i;
const FALLBACK_LINK_TEXT = 'See SAM.gov link';
const METADATA_PLACEHOLDERS = new Set(['response date', 'date offers due', '(blank)', 'unknown naics', 'not provided']);

function tableExists(db, tableName) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [tableName],
      (err, row) => {
        if (err) return reject(err);
        resolve(Boolean(row));
      }
    );
  });
}

function isSoftSqliteSchemaError(err) {
  if (!err || !err.message) return false;
  return /SQLITE_ERROR: no such table:/i.test(err.message) || /SQLITE_ERROR: no such column:/i.test(err.message);
}

function allAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        if (isSoftSqliteSchemaError(err)) return resolve([]);
        return reject(err);
      }
      resolve(rows);
    });
  });
}

function getAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        if (isSoftSqliteSchemaError(err)) return resolve(null);
        return reject(err);
      }
      resolve(row);
    });
  });
}

function normalizeCode(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\.0$/, '').toUpperCase();
}

function normalizePscCode(value) {
  const raw = normalizeCode(value);
  if (!raw) return '';
  const tokenMatch = raw.match(/[A-Z0-9]{3,4}/);
  return tokenMatch ? tokenMatch[0] : raw;
}

function normalizeNaicsCode(value) {
  const raw = normalizeCode(value).replace(/[^0-9]/g, '');
  if (!raw) return '';
  if (raw.length === 5) return `${raw}0`;
  if (raw.length > 6) return raw.slice(0, 6);
  return raw;
}

function parseTitleSimilarity(value) {
  const text = String(value || '');
  const match = text.match(/(\d+(?:\.\d+)?)%/);
  return match ? Math.min(1, Math.max(0, Number(match[1]) / 100)) : 0;
}

function toPercent(value) {
  return Math.round(Math.min(1, Math.max(0, toNumber(value))) * 1000) / 10;
}

function scoreBand(value, thresholds = { high: 0.7, medium: 0.45 }) {
  if (value >= thresholds.high) return 'HIGH';
  if (value >= thresholds.medium) return 'MEDIUM';
  return 'LOW';
}

function inferContractType(pscCode) {
  if (/^D|^DA|^DJ|^DK/.test(pscCode)) return 'IT services / support';
  if (/^7A|^7F/.test(pscCode)) return 'Software licensing / subscriptions';
  if (/^R/.test(pscCode)) return 'Professional services';
  if (/^S/.test(pscCode)) return 'Facility / maintenance services';
  return 'Mixed contract profile';
}

function inferCompetitionLevel(semanticScore, confidenceTier) {
  if (confidenceTier === 'MEDIUM' && semanticScore >= 0.55) return 'Targeted competitive set (moderate)';
  if (confidenceTier === 'MEDIUM') return 'Competitive';
  return 'Broad market competition (higher)';
}

function inferAwardSize(compositeScore) {
  if (compositeScore >= 0.68) return '$250K to $5M typical range';
  if (compositeScore >= 0.55) return '$100K to $2M typical range';
  return '$25K to $750K typical range';
}

function inferSmallBusinessFriendliness(confidenceTier, suppressionFlags) {
  if (suppressionFlags.pscBlocked || suppressionFlags.naicsBlocked) return 'Low (suppressed category risk)';
  if (confidenceTier === 'MEDIUM') return 'Moderate to high';
  return 'Moderate';
}

function firstNonEmpty(obj, keys) {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

function extractContactEmail(contactInfo) {
  const text = String(contactInfo || '');
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
}

function extractContactPhone(contactInfo) {
  const text = String(contactInfo || '');
  const match = text.match(/\+?\d[\d\s().-]{7,}\d/);
  return match ? match[0].trim() : null;
}

function cleanOpportunityDescription(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const boilerplatePattern = /^The \.gov means it.?s official\.[\s\S]*?encrypted and transmitted securely\.?/i;
  const cleaned = text.replace(boilerplatePattern, '').trim();
  return cleaned || null;
}

function paraphraseDescription(value) {
  const cleaned = cleanOpportunityDescription(value);
  if (!cleaned) return FALLBACK_LINK_TEXT;

  const withoutFar = cleaned
    .replace(/FAR\s+\d+(?:\.\d+)*(?:\([a-z0-9]+\))*/gi, '')
    .replace(/\b(offeror|solicitation number|contracting officer)\b[^.]*\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!withoutFar) return FALLBACK_LINK_TEXT;
  const sentences = withoutFar.split(/(?<=[.!?])\s+/).filter(Boolean);
  const compact = sentences.slice(0, 2).join(' ').trim();

  return compact || FALLBACK_LINK_TEXT;
}

function hasRealDate(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return true;
  if (/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(text)) return true;
  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(text) && /\d/.test(text)) return true;
  return false;
}

function isPlaceholderValue(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  return METADATA_PLACEHOLDERS.has(text.toLowerCase());
}

function fallbackOrValue(value, validator) {
  const text = String(value || '').trim();
  if (!text) return FALLBACK_LINK_TEXT;
  if (isPlaceholderValue(text)) return FALLBACK_LINK_TEXT;
  if (validator && !validator(text)) return FALLBACK_LINK_TEXT;
  return text;
}

function extractMissionReason(text) {
  const cleaned = cleanOpportunityDescription(text);
  if (!cleaned) return FALLBACK_LINK_TEXT;

  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  const missionSentence = sentences.find((line) => /\b(support|provide|procure|requirement|capability|mission|modernization|services?)\b/i.test(line));
  if (!missionSentence) return FALLBACK_LINK_TEXT;
  return missionSentence.trim().slice(0, 220);
}

function generateWhatLine(metadata) {
  const title = String(metadata.title || metadata.fpdsTitle || '').trim();
  const psc = String(metadata.psc || '').trim();
  const naics = String(metadata.naics || '').trim();

  if (!title) return FALLBACK_LINK_TEXT;
  if (psc || naics) return `${title} (PSC ${psc || 'N/A'}, NAICS ${naics || 'N/A'})`;
  return title;
}

function normalizeTitleKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isNearTitleMatch(a, b) {
  const one = normalizeTitleKey(a);
  const two = normalizeTitleKey(b);
  if (!one || !two) return false;
  if (one === two) return true;
  if (one.includes(two) || two.includes(one)) return true;

  const wordsA = new Set(one.split(' ').filter(Boolean));
  const wordsB = new Set(two.split(' ').filter(Boolean));
  const overlap = [...wordsA].filter((word) => wordsB.has(word)).length;
  const denom = Math.max(wordsA.size, wordsB.size, 1);
  return (overlap / denom) >= 0.85;
}

function isLikelyDuplicate(opportunityA, opportunityB) {
  const titleMatch = isNearTitleMatch(opportunityA.opportunity_title, opportunityB.opportunity_title);
  const fpdsTitleMatch = normalizeTitleKey(opportunityA.fpds_title) && normalizeTitleKey(opportunityA.fpds_title) === normalizeTitleKey(opportunityB.fpds_title);
  const pscNaicsMatch = normalizePscCode(opportunityA.fpds_psc_code) === normalizePscCode(opportunityB.fpds_psc_code)
    && normalizeNaicsCode(opportunityA.fpds_naics_code) === normalizeNaicsCode(opportunityB.fpds_naics_code);
  const officeMatch = normalizeTitleKey(opportunityA.opportunity_office) && normalizeTitleKey(opportunityA.opportunity_office) === normalizeTitleKey(opportunityB.opportunity_office);
  const dueDateMatch = String(opportunityA.opportunity_due_date || '').trim() !== ''
    && String(opportunityA.opportunity_due_date || '').trim() === String(opportunityB.opportunity_due_date || '').trim();
  const urlMatch = String(opportunityA.opportunity_sam_url || '').trim() !== ''
    && String(opportunityA.opportunity_sam_url || '').trim() === String(opportunityB.opportunity_sam_url || '').trim();

  const evidence = [titleMatch, fpdsTitleMatch, pscNaicsMatch, officeMatch, dueDateMatch, urlMatch].filter(Boolean).length;
  return evidence >= 3 && (titleMatch || urlMatch || fpdsTitleMatch);
}

function dedupeFeedRows(rows) {
  const kept = [];
  const suppressed = [];

  for (const row of rows) {
    const duplicateOf = kept.find((candidate) => isLikelyDuplicate(row, candidate));
    if (duplicateOf) {
      suppressed.push({ ...row, duplicate_suppressed_internal: true, duplicate_of_id: duplicateOf.id });
      continue;
    }
    kept.push({ ...row, duplicate_suppressed_internal: false });
  }

  return kept;
}

function generateHumanSummary(samText, metadata) {
  const who = fallbackOrValue(metadata.agencyOffice || metadata.contactEmail || metadata.contactPhone);
  const what = fallbackOrValue(generateWhatLine(metadata));
  const when = fallbackOrValue(metadata.dueDate, hasRealDate);
  const where = fallbackOrValue(metadata.placeOfPerformance);
  const why = fallbackOrValue(extractMissionReason(samText));

  return [
    `WHO: ${who}`,
    `WHAT: ${what}`,
    `WHEN: ${when}`,
    `WHERE: ${where}`,
    `WHY: ${why}`,
  ].join('\n');
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function htmlLayout({ title, content, includeNav = true, extraHead = '' }) {
  const nav = includeNav
    ? `
      <nav class="top-nav">
        <div class="brand">JE ROCKER LC</div>
        <div class="top-nav-links">
          <a href="/cover">Cover Page</a>
          <a href="/business-driver">Business Driver</a>
          <a href="/primary-dashboard">Primary Dashboard</a>
          <a href="/client-dashboard">Client Dashboard</a>
          <a href="/grant-engine">Grant Engine</a>
        </div>
      </nav>
    `
    : '';

  const statusStrip = `
    <section class="global-status-strip" aria-label="System status strip">
      <div class="global-status-item"><span class="global-status-label">System</span><span class="global-status-value" id="global-system-status">Loading...</span></div>
      <div class="global-status-item"><span class="global-status-label">Last Scraper</span><span class="global-status-value" id="global-last-scraper">Loading...</span></div>
      <div class="global-status-item"><span class="global-status-label">Last Matcher</span><span class="global-status-value" id="global-last-matcher">Loading...</span></div>
      <div class="global-status-item"><span class="global-status-label">Last Updated</span><span class="global-status-value" id="global-last-updated">Loading...</span></div>
      <div class="global-status-item global-status-nodes"><span class="global-status-label">Cluster</span><span class="global-status-value" id="global-cluster-nodes">Loading...</span></div>
    </section>
  `;

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${title}</title>
      <link rel="stylesheet" href="/src/styles/global.css" />
      <link rel="stylesheet" href="/src/styles/layout.css" />
      <link rel="stylesheet" href="/src/styles/dashboard.css" />
      <link rel="stylesheet" href="/src/styles/grants.css" />
      ${extraHead}
    </head>
    <body>
      <div class="page">
        <div class="container">
          ${nav}
          ${statusStrip}
          ${content}
        </div>
      </div>
      <script>
        (() => {
          Promise.all([
            fetch('/api/system/state').then((r) => r.json()),
            fetch('/api/engine/last-refresh').then((r) => r.json()),
            fetch('/api/scraper/last-run').then((r) => r.json()),
            fetch('/api/matcher/last-run').then((r) => r.json()),
          ])
            .then(([system, refresh, scraper, matcher]) => {
              const setText = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.textContent = value;
              };
              const lastUpdated = refresh.last_refresh || scraper.last_run || 'Unknown';
              setText('global-system-status', system.status || 'Unknown');
              setText('global-last-scraper', scraper.last_run || 'Unknown');
              setText('global-last-matcher', matcher.last_run || 'Unknown');
              setText('global-last-updated', lastUpdated || 'Unknown');
              setText(
                'global-cluster-nodes',
                (system.cluster_nodes || []).map((node) => node.name + ': ' + node.status).join(' · ') || 'Unavailable',
              );
            })
            .catch(() => {
              const fallback = ['global-system-status', 'global-last-scraper', 'global-last-matcher', 'global-last-updated', 'global-cluster-nodes'];
              fallback.forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.textContent = 'Unavailable';
              });
            });
        })();
      </script>
    </body>
  </html>`;
}

function panel(title, fields = [], id) {
  const rows = fields.map((f) => `<div class="kv"><span>${f}</span><span id="${id ? `${id}-${f.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : ''}">Loading...</span></div>`).join('');
  return `<section class="panel-card"><h3>${title}</h3>${rows}</section>`;
}

function classifySearch(query) {
  const q = String(query || '').trim();
  if (!q) return 'empty';
  if (/^\d{4}$/.test(q) || /^(fy)?20\d{2}$/i.test(q)) return 'fiscal_year';
  if (/^[A-Z]{1}\d{3}$/i.test(q) || /^\d{4}$/.test(q)) return 'psc';
  if (/^\d{5,6}$/.test(q)) return 'naics';
  if (/^[A-Z0-9-]{6,}$/i.test(q) && /\d/.test(q) && /-/.test(q)) return 'opportunity';
  if (/^[A-Z0-9_:-]{12,}$/i.test(q) && /\d/.test(q)) return 'award';
  if (q.includes('vendor:')) return 'vendor';
  if (q.includes('agency:')) return 'agency';
  return 'keyword';
}

function uniqueBy(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

const tableColumnsCache = new Map();
const responseCache = new Map();

async function getTableColumns(db, tableName) {
  const dbKey = db === fpds ? 'fpds' : db === opp ? 'opp' : db === matches ? 'matches' : 'db';
  const cacheKey = `${dbKey}:${tableName}`;
  if (tableColumnsCache.has(cacheKey)) {
    return tableColumnsCache.get(cacheKey);
  }
  const rows = await allAsync(db, `PRAGMA table_info(${tableName})`);
  const cols = rows.map((r) => r.name);
  tableColumnsCache.set(cacheKey, cols);
  return cols;
}

function pickFirstAvailable(columns, candidates, fallback = null) {
  for (const c of candidates) {
    if (columns.includes(c)) return c;
  }
  return fallback;
}

async function fromCache(cacheKey, ttlMs, loader) {
  const now = Date.now();
  const hit = responseCache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }
  const value = await loader();
  responseCache.set(cacheKey, { value, expiresAt: now + ttlMs });
  return value;
}

function safeNum(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function formatMoneyCompact(value) {
  const num = safeNum(value);
  if (num <= 0) return '$0';
  if (num >= 1000000000) return `$${(num / 1000000000).toFixed(1)}B`;
  if (num >= 1000000) return `$${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `$${(num / 1000).toFixed(1)}K`;
  return `$${Math.round(num)}`;
}

async function loadPrimarySummaryBundle() {
  return fromCache('primary:summary:bundle', 20000, async () => {
    const [
      totalMatchesRow,
      reviewRow,
      highFitRow,
      incumbentRow,
      topAgencies,
      topVendors,
    ] = await Promise.all([
      getAsync(matches, 'SELECT COUNT(*) AS count FROM matches'),
      getAsync(matches, 'SELECT COUNT(*) AS count FROM matches_low_confidence'),
      getAsync(matches, 'SELECT COUNT(*) AS count FROM matches WHERE semantic_score >= 0.6'),
      getAsync(matches, "SELECT COUNT(*) AS count FROM matches WHERE incumbent_vendor IS NOT NULL AND TRIM(incumbent_vendor) <> '' AND lower(incumbent_vendor) <> 'unknown'"),
      allAsync(fpds, 'SELECT name, count, obligated FROM fpds_intel_agencies ORDER BY obligated DESC LIMIT 15'),
      allAsync(fpds, 'SELECT name, count, obligated FROM fpds_intel_vendors ORDER BY obligated DESC LIMIT 15'),
    ]);

    return {
      totalMatches: safeNum(totalMatchesRow?.count),
      reviewCount: safeNum(reviewRow?.count),
      highFitCount: safeNum(highFitRow?.count),
      incumbentCount: safeNum(incumbentRow?.count),
      topAgencies,
      topVendors,
    };
  });
}

async function loadPrimaryDeepBundle() {
  return fromCache('primary:deep:bundle', 30000, async () => {
    const [
      topMatches,
      vendorDensity,
      agencyDensity,
      pscDensity,
      incumbents,
      latestDeadlines,
    ] = await Promise.all([
      allAsync(matches, `
        SELECT
          opportunity_id,
          opportunity_title,
          fpds_agency,
          fpds_psc_code,
          fpds_contract_id,
          semantic_score,
          confidence_tier,
          incumbent_vendor,
          incumbent_award_value,
          timestamp
        FROM matches
        ORDER BY semantic_score DESC, id DESC
        LIMIT 250
      `),
      allAsync(matches, `
        SELECT
          COALESCE(NULLIF(TRIM(incumbent_vendor), ''), 'Unknown') AS vendor,
          COUNT(*) AS records,
          SUM(COALESCE(incumbent_award_value, 0)) AS spend
        FROM matches
        GROUP BY vendor
        ORDER BY spend DESC, records DESC
        LIMIT 25
      `),
      allAsync(matches, `
        SELECT
          COALESCE(NULLIF(TRIM(fpds_agency), ''), 'Unknown') AS agency,
          COUNT(*) AS records
        FROM matches
        GROUP BY agency
        ORDER BY records DESC
        LIMIT 25
      `),
      allAsync(matches, `
        SELECT
          COALESCE(NULLIF(TRIM(fpds_psc_code), ''), 'N/A') AS psc,
          COUNT(*) AS records
        FROM matches
        GROUP BY psc
        ORDER BY records DESC
        LIMIT 25
      `),
      allAsync(matches, `
        SELECT
          incumbent_vendor,
          COUNT(*) AS records,
          SUM(COALESCE(incumbent_award_value, 0)) AS spend
        FROM matches
        WHERE incumbent_vendor IS NOT NULL
          AND TRIM(incumbent_vendor) <> ''
          AND lower(incumbent_vendor) <> 'unknown'
        GROUP BY incumbent_vendor
        ORDER BY spend DESC, records DESC
        LIMIT 25
      `),
      allAsync(opp, `
        SELECT notice_id, title, agency, response_date
        FROM opportunities
        WHERE response_date IS NOT NULL
          AND TRIM(response_date) <> ''
        ORDER BY response_date ASC
        LIMIT 25
      `),
    ]);

    return {
      topMatches,
      vendorDensity,
      agencyDensity,
      pscDensity,
      incumbents,
      latestDeadlines,
    };
  });
}

async function loadClientSummaryBundle() {
  return fromCache('client:summary:bundle', 20000, async () => {
    const [primarySummary, lastMatcherRow, lastOpportunityRow] = await Promise.all([
      loadPrimarySummaryBundle(),
      getAsync(matches, 'SELECT MAX(timestamp) AS last_matcher_run FROM matches'),
      getAsync(opp, 'SELECT MAX(response_date) AS last_opportunity_date FROM opportunities'),
    ]);

    return {
      ...primarySummary,
      lastMatcherRun: lastMatcherRow?.last_matcher_run || 'Unknown',
      lastOpportunityDate: lastOpportunityRow?.last_opportunity_date || 'Unknown',
    };
  });
}

async function loadClientDeepBundle() {
  return fromCache('client:deep:bundle', 30000, async () => {
    const [primaryDeep, topMatches, naicsDensity, strategyMix] = await Promise.all([
      loadPrimaryDeepBundle(),
      allAsync(matches, `
        SELECT
          opportunity_id,
          opportunity_title,
          fpds_agency,
          fpds_naics_code,
          fpds_psc_code,
          semantic_score,
          confidence_tier,
          match_reason,
          matching_strategy,
          incumbent_vendor,
          incumbent_award_value,
          timestamp
        FROM matches
        ORDER BY semantic_score DESC, id DESC
        LIMIT 220
      `),
      allAsync(matches, `
        SELECT
          COALESCE(NULLIF(TRIM(fpds_naics_code), ''), 'N/A') AS naics,
          COUNT(*) AS records
        FROM matches
        GROUP BY naics
        ORDER BY records DESC
        LIMIT 20
      `),
      allAsync(matches, `
        SELECT
          COALESCE(NULLIF(TRIM(matching_strategy), ''), 'Unknown') AS strategy,
          COUNT(*) AS records
        FROM matches
        GROUP BY strategy
        ORDER BY records DESC
        LIMIT 20
      `),
    ]);

    return {
      ...primaryDeep,
      topMatches,
      naicsDensity,
      strategyMix,
    };
  });
}

function parseFeedLimit(rawValue, fallback = 500) {
  const parsed = Number.parseInt(String(rawValue || fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(25, Math.min(parsed, 2000));
}

async function loadMatchFeed(tableName, limit = 500) {
  const rows = await allAsync(
    matches,
    `
      SELECT *
      FROM ${tableName}
      ORDER BY semantic_score DESC, composite_score DESC, id DESC
      LIMIT ?
    `
    ,
    [limit]
  );

  const ids = [...new Set(rows.map((row) => String(row.opportunity_id || '').trim()).filter(Boolean))];
  if (!ids.length) return dedupeFeedRows(rows);

  const placeholders = ids.map(() => '?').join(',');
  const opportunitiesById = await allAsync(
    opp,
    `
      SELECT notice_id, office, response_date, url
      FROM opportunities
      WHERE notice_id IN (${placeholders})
         OR REPLACE(notice_id, '-', '') IN (${placeholders})
         OR REPLACE(notice_id, '.', '') IN (${placeholders})
    `,
    [...ids, ...ids, ...ids]
  );

  const lookup = new Map();
  for (const row of opportunitiesById) {
    const keys = [
      String(row.notice_id || '').trim(),
      String(row.notice_id || '').replace(/[-.]/g, '').trim(),
    ].filter(Boolean);
    for (const key of keys) {
      if (!lookup.has(key)) lookup.set(key, row);
    }
  }

  const enriched = rows.map((row) => {
    const rawId = String(row.opportunity_id || '').trim();
    const compactId = rawId.replace(/[-.]/g, '');
    const oppRow = lookup.get(rawId) || lookup.get(compactId) || {};
    return {
      ...row,
      opportunity_office: oppRow.office || null,
      opportunity_due_date: oppRow.response_date || null,
      opportunity_sam_url: oppRow.url || row.opportunity_url || null,
    };
  });

  return dedupeFeedRows(enriched);
}

app.get('/api/matches', async (req, res) => {
  try {
    const limit = parseFeedLimit(req.query.limit, 500);
    res.json(await loadMatchFeed('matches', limit));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/primary_feed', async (req, res) => {
  try {
    const limit = parseFeedLimit(req.query.limit, 500);
    res.json(await loadMatchFeed('matches', limit));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/review', async (req, res) => {
  try {
    const limit = parseFeedLimit(req.query.limit, 500);
    res.json(await loadMatchFeed('matches_low_confidence', limit));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/review_feed', async (req, res) => {
  try {
    const limit = parseFeedLimit(req.query.limit, 500);
    res.json(await loadMatchFeed('matches_low_confidence', limit));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function loadSystemState() {
  function lastModifiedAt(filePath) {
    try {
      return fs.statSync(filePath).mtime.toISOString();
    } catch {
      return null;
    }
  }

  const oppCols = await getTableColumns(opp, 'opportunities');
  const updatedCol = pickFirstAvailable(oppCols, ['updated_at', 'updated', 'scraped_at', 'created_at', 'response_date']);

  const [oppCountRow, primaryCountRow, reviewCountRow, latestOppRow, latestMatchRow] = await Promise.all([
    getAsync(opp, 'SELECT COUNT(*) AS count FROM opportunities'),
    getAsync(matches, 'SELECT COUNT(*) AS count FROM matches'),
    getAsync(matches, 'SELECT COUNT(*) AS count FROM matches_low_confidence'),
    updatedCol ? getAsync(opp, `SELECT MAX(${updatedCol}) AS last_scraper_run FROM opportunities`) : Promise.resolve({ last_scraper_run: null }),
    getAsync(matches, 'SELECT MAX(timestamp) AS last_matcher_run FROM matches'),
  ]);

  const totalMatches = toNumber(primaryCountRow?.count) + toNumber(reviewCountRow?.count);
  const matchedOpportunities = toNumber(primaryCountRow?.count);
  const totalOpportunities = toNumber(oppCountRow?.count);
  const matchCoverage = totalOpportunities > 0 ? ((matchedOpportunities / totalOpportunities) * 100).toFixed(1) : '0.0';
    const pipelineScraperRun = lastModifiedAt(path.join(PIPELINE_ROOT, 'db', 'opportunities.db'));
    const pipelineMatcherRun = lastModifiedAt(path.join(PIPELINE_ROOT, 'db', 'matches.db'));

  return {
      total_opportunities: totalOpportunities,
      last_scraper_run: pipelineScraperRun || latestOppRow?.last_scraper_run || 'Unknown',
      last_matcher_run: pipelineMatcherRun || latestMatchRow?.last_matcher_run || 'Unknown',
      pipeline_status: 'Ready',
      spend_ingestion_status: 'Loaded',
      years_loaded: '2019-2026',
      vendor_updates: 'Available',
      agency_spend_updates: 'Available',
      total_matches: totalMatches,
      matched_opportunities: matchedOpportunities,
      match_coverage: `${matchCoverage}%`,
      forecasting_signals: 'Active',
  };
}

app.get('/api/system/state', async (req, res) => {
  try {
    const state = await loadSystemState();
    res.json({
      status: state.pipeline_status,
      cluster_nodes: [
        { name: 'MacMiller', role: 'Wiring + Intelligence Node', status: 'Active' },
        { name: 'Macklemore', role: 'Driver Node', status: 'Ready' },
        { name: 'MacMal (M6)', role: 'Future Ingestion Node', status: 'Planned' },
      ],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/engine/last-refresh', async (req, res) => {
  try {
    const state = await loadSystemState();
    res.json({ last_refresh: state.last_scraper_run, pipeline_status: state.pipeline_status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/scraper/last-run', async (req, res) => {
  try {
    const state = await loadSystemState();
    res.json({ last_run: state.last_scraper_run, status: state.pipeline_status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/matcher/last-run', async (req, res) => {
  try {
    const state = await loadSystemState();
    res.json({ last_run: state.last_matcher_run, status: state.pipeline_status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/dashboard_summary', async (req, res) => {
  try {
    res.json(await loadSystemState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/internal_search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const type = classifySearch(query);

  if (!query) {
    return res.json({ type: 'empty', rows: [] });
  }

  if (query.length < 2) {
    return res.json({ type: 'short_query', rows: [] });
  }

  try {
    const like = `%${query.toLowerCase()}%`;
    const [agencyCols, vendorCols, naicsCols, pscCols] = await Promise.all([
      getTableColumns(fpds, 'fpds_intel_agencies'),
      getTableColumns(fpds, 'fpds_intel_vendors'),
      getTableColumns(fpds, 'fpds_intel_naics'),
      getTableColumns(fpds, 'fpds_intel_psc'),
    ]);

    const agencyNameCol = pickFirstAvailable(agencyCols, ['name', 'agency', 'label']);
    const agencyCountCol = pickFirstAvailable(agencyCols, ['count', 'awards', 'records'], agencyNameCol);
    const agencyObCol = pickFirstAvailable(agencyCols, ['obligated', 'amount', 'total_obligated'], agencyCountCol);

    const vendorNameCol = pickFirstAvailable(vendorCols, ['name', 'vendor', 'label']);
    const vendorCountCol = pickFirstAvailable(vendorCols, ['count', 'awards', 'records'], vendorNameCol);
    const vendorObCol = pickFirstAvailable(vendorCols, ['obligated', 'amount', 'total_obligated'], vendorCountCol);

    const naicsCodeCol = pickFirstAvailable(naicsCols, ['code', 'naics', 'naics_code', 'label']);
    const naicsCountCol = pickFirstAvailable(naicsCols, ['count', 'awards', 'records'], naicsCodeCol);
    const naicsObCol = pickFirstAvailable(naicsCols, ['obligated', 'amount', 'total_obligated'], naicsCountCol);

    const pscCodeCol = pickFirstAvailable(pscCols, ['code', 'psc', 'psc_code', 'label']);
    const pscCountCol = pickFirstAvailable(pscCols, ['count', 'awards', 'records'], pscCodeCol);
    const pscObCol = pickFirstAvailable(pscCols, ['obligated', 'amount', 'total_obligated'], pscCountCol);

    if (type === 'agency') {
      if (!agencyNameCol) return res.json({ type, rows: [] });
      const rows = await allAsync(fpds, `
        SELECT ${agencyNameCol} AS name, ${agencyCountCol} AS count, ${agencyObCol} AS obligated
        FROM fpds_intel_agencies
        WHERE lower(${agencyNameCol}) LIKE ?
        ORDER BY obligated DESC
        LIMIT 20
      `, [like]);
      return res.json({ type, rows });
    }

    if (type === 'vendor') {
      if (!vendorNameCol) return res.json({ type, rows: [] });
      const rows = await allAsync(fpds, `
        SELECT ${vendorNameCol} AS name, ${vendorCountCol} AS count, ${vendorObCol} AS obligated
        FROM fpds_intel_vendors
        WHERE lower(${vendorNameCol}) LIKE ?
        ORDER BY obligated DESC
        LIMIT 20
      `, [like]);
      return res.json({ type, rows });
    }

    if (type === 'naics') {
      if (!naicsCodeCol) return res.json({ type, rows: [] });
      const rows = await allAsync(fpds, `
        SELECT ${naicsCodeCol} AS code, ${naicsCountCol} AS count, ${naicsObCol} AS obligated
        FROM fpds_intel_naics
        WHERE ${naicsCodeCol} LIKE ?
        ORDER BY obligated DESC
        LIMIT 20
      `, [`%${query.replace(/[^0-9]/g, '')}%`]);
      return res.json({ type, rows });
    }

    if (type === 'psc') {
      if (!pscCodeCol) return res.json({ type, rows: [] });
      const p = query.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const rows = await allAsync(fpds, `
        SELECT ${pscCodeCol} AS code, ${pscCountCol} AS count, ${pscObCol} AS obligated
        FROM fpds_intel_psc
        WHERE upper(${pscCodeCol}) LIKE ?
        ORDER BY obligated DESC
        LIMIT 20
      `, [`%${p}%`]);
      return res.json({ type, rows });
    }

    if (type === 'opportunity') {
      const oppRows = await allAsync(opp, `
        SELECT notice_id, title, agency, naics_code, naics_description, psc, office, response_date, url
        FROM opportunities
        WHERE lower(notice_id) LIKE ? OR lower(title) LIKE ?
        ORDER BY response_date DESC
        LIMIT 12
      `, [like, like]);

      const matchRows = await allAsync(matches, `
        SELECT id, opportunity_id, opportunity_title, fpds_agency, fpds_naics_code, fpds_psc_code, semantic_score, confidence_tier
        FROM matches
        WHERE lower(opportunity_id) LIKE ? OR lower(opportunity_title) LIKE ?
        ORDER BY semantic_score DESC
        LIMIT 20
      `, [like, like]);

      return res.json({ type, rows: { opportunities: oppRows, matches: matchRows } });
    }

    if (type === 'award') {
      const rows = await allAsync(matches, `
        SELECT id, fpds_contract_id, fpds_contract_key, opportunity_title, fpds_agency, incumbent_vendor, incumbent_award_value
        FROM matches
        WHERE lower(fpds_contract_id) LIKE ? OR lower(fpds_contract_key) LIKE ?
        ORDER BY id DESC
        LIMIT 20
      `, [like, like]);
      return res.json({ type, rows });
    }

    if (type === 'fiscal_year') {
      const yy = query.replace(/[^0-9]/g, '');
      const rows = await allAsync(matches, `
        SELECT id, opportunity_id, opportunity_title, fpds_contract_id, timestamp
        FROM matches
        WHERE timestamp LIKE ?
        ORDER BY timestamp DESC
        LIMIT 30
      `, [`%${yy}%`]);
      return res.json({ type, rows });
    }

    const includeDeepKeywordScan = query.length >= 4;
    const [agencies, vendors, opportunities, awards] = await Promise.all([
      agencyNameCol
        ? allAsync(fpds, `SELECT ${agencyNameCol} AS name, ${agencyCountCol} AS count, ${agencyObCol} AS obligated FROM fpds_intel_agencies WHERE lower(${agencyNameCol}) LIKE ? ORDER BY obligated DESC LIMIT 20`, [like])
        : Promise.resolve([]),
      vendorNameCol
        ? allAsync(fpds, `SELECT ${vendorNameCol} AS name, ${vendorCountCol} AS count, ${vendorObCol} AS obligated FROM fpds_intel_vendors WHERE lower(${vendorNameCol}) LIKE ? ORDER BY obligated DESC LIMIT 20`, [like])
        : Promise.resolve([]),
      includeDeepKeywordScan
        ? allAsync(opp, `SELECT notice_id, title, agency, response_date, url FROM opportunities WHERE lower(title) LIKE ? ORDER BY response_date DESC LIMIT 10`, [like])
        : Promise.resolve([]),
      includeDeepKeywordScan
        ? allAsync(matches, `SELECT fpds_contract_id, opportunity_title, fpds_agency FROM matches WHERE lower(opportunity_title) LIKE ? OR lower(fpds_contract_id) LIKE ? LIMIT 10`, [like, like])
        : Promise.resolve([]),
    ]);

    const rows = uniqueBy([
      ...agencies.map((x) => ({ bucket: 'agency', ...x })),
      ...vendors.map((x) => ({ bucket: 'vendor', ...x })),
      ...opportunities.map((x) => ({ bucket: 'opportunity', ...x })),
      ...awards.map((x) => ({ bucket: 'award', ...x })),
    ], (x) => JSON.stringify(x));

    res.json({ type: 'keyword', rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/match_intel/:id', async (req, res) => {
  const source = req.query.source === 'review' ? 'matches_low_confidence' : 'matches';

  try {
    let row = await getAsync(matches, `SELECT * FROM ${source} WHERE id = ?`, [req.params.id]);

    if (!row && source === 'matches') {
      row = await getAsync(matches, 'SELECT * FROM matches_low_confidence WHERE id = ?', [req.params.id]);
    }

    if (!row) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const opportunityRow = await getAsync(
      opp,
      `
        SELECT *
        FROM opportunities
        WHERE notice_id = ? OR notice_id = REPLACE(?, '-', '') OR notice_id = REPLACE(?, '.', '')
        LIMIT 1
      `,
      [row.opportunity_id, row.opportunity_id, row.opportunity_id]
    );

    const psc = normalizePscCode(row.fpds_psc_code);
    const naics = normalizeNaicsCode(row.fpds_naics_code);
    const titleText = `${row.opportunity_title || ''} ${row.fpds_title || ''}`;
    const semanticScore = toNumber(row.semantic_score);
    const compositeScore = toNumber(row.composite_score);
    const titleSimilarity = parseTitleSimilarity(row.match_reason);
    const confidenceTier = row.confidence_tier || 'LOW';
    const suppressionFlags = {
      pscBlocked: PSC_SUPPRESS.has(psc),
      naicsBlocked: NAICS_SUPPRESS.has(naics),
      titleBlocked: TITLE_SUPPRESS_RE.test(titleText),
    };

    const hasAgencySignal = /agency/i.test(String(row.matching_strategy || ''));
    const hasPscSignal = /psc/i.test(String(row.matching_strategy || ''));
    const hasNaicsSignal = /naics/i.test(String(row.matching_strategy || ''));

    const pscSimilarity = hasPscSignal ? Math.max(0.75, semanticScore) : semanticScore * 0.55;
    const naicsSimilarity = hasNaicsSignal ? Math.max(0.72, semanticScore) : semanticScore * 0.5;
    const fpdsSimilarity = (semanticScore * 0.55) + (compositeScore * 0.25) + (titleSimilarity * 0.2);
    const vendorSemantic = row.incumbent_vendor ? (semanticScore * 0.8 + 0.1) : (semanticScore * 0.7);
    const jeRockerFit = (semanticScore * 0.45) + (compositeScore * 0.35) + (hasAgencySignal ? 0.1 : 0) + (hasPscSignal ? 0.1 : 0);
    const suppressionPenalty = (suppressionFlags.pscBlocked ? 0.2 : 0)
      + (suppressionFlags.naicsBlocked ? 0.2 : 0)
      + (suppressionFlags.titleBlocked ? 0.2 : 0);
    const winnabilityScore = Math.max(0, Math.min(1, jeRockerFit - suppressionPenalty * 0.5));

    const suppressionReasons = [];
    if (suppressionFlags.pscBlocked) suppressionReasons.push(`PSC ${psc} is in suppression list`);
    if (suppressionFlags.naicsBlocked) suppressionReasons.push(`NAICS ${naics} is in suppression list`);
    if (suppressionFlags.titleBlocked) suppressionReasons.push('Title triggered suppression terms');

    const riskIndicators = [];
    if (confidenceTier === 'LOW') riskIndicators.push('Low confidence tier requires manual validation');
    if (suppressionReasons.length) riskIndicators.push('Suppression risk flags detected');
    if (semanticScore < 0.45) riskIndicators.push('Weak semantic alignment');
    if (compositeScore < 0.5) riskIndicators.push('Weak classical signal');
    if (!riskIndicators.length) riskIndicators.push('No immediate red flags');

    const samUrl = firstNonEmpty(opportunityRow, ['url']) || firstNonEmpty(row, ['opportunity_url']) || null;
    const fpdsUrl = row.fpds_contract_id
      ? `https://www.fpds.gov/ezsearch/fpdsportal?q=${encodeURIComponent(row.fpds_contract_id)}`
      : (row.fpds_contract_key ? `https://www.fpds.gov/ezsearch/fpdsportal?q=${encodeURIComponent(row.fpds_contract_key)}` : null);
    const dueDateRaw = firstNonEmpty(opportunityRow, ['response_date']) || null;
    const dueDate = fallbackOrValue(dueDateRaw, hasRealDate);
    const setAside = firstNonEmpty(opportunityRow, ['set_aside']) || null;
    const contractTypeRaw = firstNonEmpty(opportunityRow, ['naics_description']) || inferContractType(psc);
    const contractType = fallbackOrValue(contractTypeRaw);
    const placeOfPerformanceRaw = firstNonEmpty(opportunityRow, ['place_of_performance']) || null;
    const placeOfPerformance = fallbackOrValue(placeOfPerformanceRaw);
    const agencyOffice = fallbackOrValue(firstNonEmpty(opportunityRow, ['office']) || row.fpds_agency || null);
    const contactInfo = firstNonEmpty(opportunityRow, ['contact_info']) || null;
    const contactEmailRaw = extractContactEmail(contactInfo);
    const contactPhoneRaw = extractContactPhone(contactInfo);
    const contactEmail = fallbackOrValue(contactEmailRaw);
    const contactPhone = fallbackOrValue(contactPhoneRaw);
    const description = cleanOpportunityDescription(firstNonEmpty(opportunityRow, ['description']))
      || firstNonEmpty(row, ['fpds_title'])
      || null;
    const paraphrasedDescription = paraphraseDescription(firstNonEmpty(opportunityRow, ['description']));
    const humanSummary = generateHumanSummary(firstNonEmpty(opportunityRow, ['description']), {
      agencyOffice,
      contactEmail,
      title: row.opportunity_title,
      fpdsTitle: row.fpds_title,
      psc,
      naics,
      dueDate,
      placeOfPerformance,
    });

    const payload = {
      id: row.id,
      source: source === 'matches' ? 'primary' : 'review',
      opportunity: {
        id: row.opportunity_id,
        title: row.opportunity_title,
        url: row.opportunity_url,
      },
      fpds: {
        contractId: row.fpds_contract_id,
        contractKey: row.fpds_contract_key,
        title: row.fpds_title,
        agency: row.fpds_agency,
        pscCode: psc,
        naicsCode: naics,
        placeState: row.fpds_place_state,
        incumbentVendor: row.incumbent_vendor,
        incumbentAwardValue: row.incumbent_award_value,
        incumbentPeriodEnd: row.incumbent_period_end,
      },
      scores: {
        legacyScore: toNumber(row.score),
        compositeScore,
        semanticScore,
      },
      confidenceTier,
      reasoning: {
        strategy: row.matching_strategy,
        explanation: row.match_reason,
      },
      suppression: suppressionFlags,
      PSC_similarity: toPercent(pscSimilarity),
      NAICS_similarity: toPercent(naicsSimilarity),
      FPDS_similarity: toPercent(fpdsSimilarity),
      govtech_semantic_band: scoreBand(semanticScore, { high: 0.62, medium: 0.46 }),
      classical_signal_band: scoreBand(compositeScore, { high: 0.68, medium: 0.52 }),
      vendor_semantic_band: scoreBand(vendorSemantic, { high: 0.62, medium: 0.45 }),
      confidence_reasoning: `Tier ${confidenceTier} based on semantic ${toPercent(semanticScore)}% and composite ${toPercent(compositeScore)}% alignment.`,
      suppression_reasoning: suppressionReasons.length ? suppressionReasons.join('; ') : 'No suppression triggers detected.',
      agency_alignment: hasAgencySignal ? 'Aligned to known target agency signal' : 'Indirect agency alignment',
      typical_contract_type: inferContractType(psc),
      typical_competition_level: inferCompetitionLevel(semanticScore, confidenceTier),
      typical_award_size: inferAwardSize(compositeScore),
      historical_vendor_patterns: row.incumbent_vendor
        ? `${row.incumbent_vendor} appears as incumbent vendor for the matched FPDS line.`
        : 'No clear incumbent vendor pattern attached to this match.',
      je_rocker_fit_score: toPercent(jeRockerFit),
      winnability_score: toPercent(winnabilityScore),
      risk_indicators: riskIndicators,
      opportunity_cluster: `${(row.fpds_agency || 'Unknown agency')} | ${psc || 'NO-PSC'} | ${naics || 'NO-NAICS'}`,
      award_cycle_timing: confidenceTier === 'MEDIUM' ? 'Near-term pursuit candidate' : 'Research and pre-position candidate',
      incumbent_vendor: row.incumbent_vendor || 'Unknown / not provided',
      contract_vehicle: row.fpds_contract_key || row.fpds_contract_id || 'Unspecified vehicle',
      small_business_friendliness: inferSmallBusinessFriendliness(confidenceTier, suppressionFlags),
        sam_url: samUrl,
        solicitation_pdf_url: null,
        attachments_url: samUrl,
        amendments_url: samUrl,
        fpds_url: fpdsUrl,
        due_date: dueDate,
        set_aside: setAside,
        contract_type: contractType,
        place_of_performance: placeOfPerformance,
        agency_office: agencyOffice,
        contact_email: contactEmail,
        contact_phone: contactPhone,
        description,
        paraphrased_description: paraphrasedDescription,
        human_summary: humanSummary,
        summary_notice: 'For the full official description, see the SAM.gov link.',
      timestamp: row.timestamp,
    };

    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

  app.get('/api/opportunities/scored', async (req, res) => {
    try {
      const hasScores = await tableExists(opp, 'opportunity_scores');

      const sql = hasScores
        ? `
          SELECT
            o.*,
            o.notice_id AS id,
            COALESCE(s.score, 0.0) AS score,
            COALESCE(s.lane, 'no_fit') AS lane
          FROM opportunities o
          LEFT JOIN opportunity_scores s ON o.id = s.id
          ORDER BY s.score DESC
          LIMIT 10
        `
        : `
          SELECT
            o.*,
            o.notice_id AS id,
            0.0 AS score,
            'no_fit' AS lane
          FROM opportunities o
          LIMIT 10
        `;

      opp.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      });

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

app.get('/api/intel/opportunity/:id', (req, res) => {
  const id = req.params.id;

  opp.get(
    `
      SELECT agency
      FROM opportunities
      WHERE notice_id = ?
      LIMIT 1
    `,
    [id],
    (oppErr, oppRow) => {
      if (oppErr) return res.status(500).json({ error: oppErr.message });

      if (!oppRow || !oppRow.agency) {
        return fpds.all(
          `
            SELECT
              name AS agency,
              count AS awards,
              obligated
            FROM fpds_intel_award_history
            ORDER BY obligated DESC
            LIMIT 10
          `,
          [],
          (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
          }
        );
      }

      fpds.all(
        `
          SELECT
            name AS agency,
            count AS awards,
            obligated
          FROM fpds_intel_agencies
          WHERE lower(name) LIKE '%' || lower(?) || '%'
          ORDER BY obligated DESC
          LIMIT 10
        `,
        [oppRow.agency],
        (matchErr, matchRows) => {
          if (matchErr) return res.status(500).json({ error: matchErr.message });

          if (matchRows.length > 0) {
            return res.json(matchRows);
          }

          fpds.all(
            `
              SELECT
                name AS agency,
                count AS awards,
                obligated
              FROM fpds_intel_award_history
              ORDER BY obligated DESC
              LIMIT 10
            `,
            [],
            (fallbackErr, fallbackRows) => {
              if (fallbackErr) return res.status(500).json({ error: fallbackErr.message });
              res.json(fallbackRows);
            }
          );
        }
      );
    }
  );
});

app.get('/api/intel/:table', (req, res) => {
  const allowed = new Set([
    'agencies',
    'vendors',
    'naics',
    'psc',
    'award_history',
    'place',
    'contract_types',
  ]);

  const table = req.params.table;
  const requestedLimit = Number.parseInt(String(req.query.limit || '50'), 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 250))
    : 50;
  if (!allowed.has(table)) {
    return res.status(400).json({ error: 'Invalid intel table' });
  }

  fpds.all(
    `SELECT * FROM fpds_intel_${table} ORDER BY obligated DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get('/api/primary/competitive-summary', async (req, res) => {
  try {
    const bundle = await loadPrimarySummaryBundle();
    const topVendor = bundle.topVendors?.[0]?.name || 'Unknown vendor';
    const avgVendorSpend = bundle.topVendors?.length
      ? Math.round(bundle.topVendors.reduce((sum, row) => sum + safeNum(row.obligated), 0) / bundle.topVendors.length)
      : 0;

    res.json({
      status: 'summary_loaded',
      summary: [
        { label: 'matched vendors', value: String(bundle.topVendors.length), signal: 'up' },
        { label: 'historical awards', value: String(bundle.totalMatches), signal: 'steady' },
        { label: 'spend footprint', value: formatMoneyCompact(avgVendorSpend), signal: 'up' },
        { label: 'incumbent detection', value: String(bundle.incumbentCount), signal: bundle.incumbentCount > 0 ? 'alert' : 'steady' },
      ],
      insight: `Top vendor by spend signal: ${topVendor}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/primary/competitive-intel', async (req, res) => {
  try {
    const bundle = await loadPrimaryDeepBundle();
    const topIncumbents = (bundle.incumbents || []).slice(0, 10).map((row) => ({
      label: row.incumbent_vendor || 'Unknown',
      value: `${safeNum(row.records)} records • ${formatMoneyCompact(row.spend)}`,
    }));
    const topAgencies = (bundle.agencyDensity || []).slice(0, 8).map((row) => ({
      label: row.agency || 'Unknown',
      value: `${safeNum(row.records)} matched rows`,
    }));

    res.json({
      status: 'intel_ready',
      intel: {
        market_pressure: topIncumbents,
        agency_pressure: topAgencies,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/primary/agency-summary', async (req, res) => {
  try {
    const bundle = await loadPrimarySummaryBundle();
    const topAgency = bundle.topAgencies?.[0] || {};
    res.json({
      status: 'summary_loaded',
      summary: [
        { label: 'award patterns', value: `${safeNum(topAgency.count)} top-agency awards`, signal: 'up' },
        { label: 'contract types', value: `${bundle.topAgencies.length} agencies in view`, signal: 'steady' },
        { label: 'simplified buys', value: `${bundle.reviewCount} review candidates`, signal: 'steady' },
        { label: 'micro-purchase frequency', value: topAgency.name || 'Agency mix active', signal: 'up' },
      ],
      insight: `Lead agency: ${topAgency.name || 'Unknown'}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/primary/agency-intel', async (req, res) => {
  try {
    const bundle = await loadPrimaryDeepBundle();
    const topPsc = (bundle.pscDensity || []).slice(0, 10).map((row) => ({
      label: row.psc || 'N/A',
      value: `${safeNum(row.records)} records`,
    }));
    const topAgencies = (bundle.agencyDensity || []).slice(0, 10).map((row) => ({
      label: row.agency || 'Unknown',
      value: `${safeNum(row.records)} opportunities`,
    }));

    res.json({
      status: 'intel_ready',
      intel: {
        buying_motion: topAgencies,
        contract_profile: topPsc,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/primary/vendor-summary', async (req, res) => {
  try {
    const bundle = await loadPrimarySummaryBundle();
    const topVendor = bundle.topVendors?.[0] || {};
    res.json({
      status: 'summary_loaded',
      summary: [
        { label: 'vendor past performance', value: topVendor.name || 'Vendor intel unavailable', signal: 'steady' },
        { label: 'award modifications', value: `${bundle.totalMatches} records in history`, signal: 'up' },
        { label: 'spend totals', value: formatMoneyCompact(topVendor.obligated), signal: 'up' },
        { label: 'active agencies', value: `${bundle.topAgencies.length} agency signals`, signal: 'steady' },
      ],
      insight: `Top vendor count: ${safeNum(topVendor.count)}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/primary/vendor-intel', async (req, res) => {
  try {
    const bundle = await loadPrimaryDeepBundle();
    const vendorRows = (bundle.vendorDensity || []).slice(0, 12).map((row) => ({
      label: row.vendor || 'Unknown',
      value: `${safeNum(row.records)} records • ${formatMoneyCompact(row.spend)}`,
    }));
    const incumbentRows = (bundle.incumbents || []).slice(0, 8).map((row) => ({
      label: row.incumbent_vendor || 'Unknown',
      value: `${safeNum(row.records)} incumbent hits`,
    }));

    res.json({
      status: 'intel_ready',
      intel: {
        vendor_density: vendorRows,
        incumbent_history: incumbentRows,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/primary/capture-summary', async (req, res) => {
  try {
    const bundle = await loadPrimarySummaryBundle();
    res.json({
      status: 'summary_loaded',
      summary: [
        { label: 'opportunity summary', value: `${bundle.totalMatches} matched opportunities`, signal: 'steady' },
        { label: 'competitive analysis', value: `${bundle.incumbentCount} incumbent-linked rows`, signal: bundle.incumbentCount > 0 ? 'alert' : 'steady' },
        { label: 'win strategy', value: `${bundle.highFitCount} high-fit candidates`, signal: 'up' },
        { label: 'proposal checklist', value: `${bundle.reviewCount} review items`, signal: 'steady' },
      ],
      insight: 'Summary loaded. Open panel for deeper recommendations.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/primary/capture-intel', async (req, res) => {
  try {
    const focusId = String(req.query.opportunity_id || '').trim();
    if (!focusId) {
      return res.json({
        status: 'summary_only',
        reason: 'missing key fields',
        intel: {
          strategy_recommendations: [
            { label: 'next step', value: 'Provide opportunity_id for targeted capture guidance.' },
          ],
        },
      });
    }

    const bundle = await loadPrimaryDeepBundle();
    const focus = (bundle.topMatches || []).find((row) => String(row.opportunity_id || '').trim() === focusId);
    if (!focus) {
      return res.json({
        status: 'summary_only',
        reason: 'focus opportunity not found in top intelligence window',
        intel: {
          strategy_recommendations: [
            { label: 'next step', value: 'Try another opportunity_id or run broader review.' },
          ],
        },
      });
    }

    const strategyRows = [
      { label: 'target opportunity', value: focus.opportunity_title || focus.opportunity_id || 'N/A' },
      { label: 'agency posture', value: focus.fpds_agency || 'Unknown agency' },
      { label: 'confidence lane', value: focus.confidence_tier || 'LOW' },
      { label: 'semantic score', value: String(toPercent(focus.semantic_score || 0)) + '%' },
      { label: 'incumbent pressure', value: focus.incumbent_vendor || 'No incumbent identified' },
    ];

    res.json({
      status: 'intel_ready',
      intel: {
        strategy_recommendations: strategyRows,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/primary/submission-summary', async (req, res) => {
  try {
    const bundle = await loadPrimarySummaryBundle();
    const dueSoonCount = await fromCache('primary:submission:dueSoon', 20000, async () => {
      const row = await getAsync(opp, `
        SELECT COUNT(*) AS count
        FROM opportunities
        WHERE response_date IS NOT NULL
          AND TRIM(response_date) <> ''
          AND date(substr(response_date, 1, 10)) >= date('now')
      `);
      return safeNum(row?.count);
    });

    res.json({
      status: 'summary_loaded',
      summary: [
        { label: 'opportunities being pursued', value: String(bundle.totalMatches), signal: 'up' },
        { label: 'deadlines', value: `${dueSoonCount} dated opportunities`, signal: 'alert' },
        { label: 'submission status', value: `${bundle.highFitCount} high-priority candidates`, signal: 'steady' },
        { label: 'follow-ups', value: `${Math.min(5, bundle.topAgencies.length)} immediate lanes`, signal: 'up' },
      ],
      insight: 'Summary loaded. Expand for submission workflow details.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/primary/submission-intel', async (req, res) => {
  try {
    const bundle = await loadPrimaryDeepBundle();
    const rows = (bundle.latestDeadlines || []).slice(0, 12).map((row) => ({
      label: row.notice_id || row.title || 'Opportunity',
      value: `${row.response_date || 'N/A'} • ${row.agency || 'Unknown agency'}`,
    }));

    res.json({
      status: 'intel_ready',
      intel: {
        workflow_queue: rows,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/weekly-summary', async (req, res) => {
  try {
    const bundle = await loadClientSummaryBundle();
    const topAgency = bundle.topAgencies?.[0] || {};
    res.json({
      status: 'summary_loaded',
      summary: [
        { label: 'monday refresh summary', value: bundle.lastMatcherRun || 'Unknown', signal: 'steady' },
        { label: 'new opportunities', value: `${bundle.highFitCount} high-fit records`, signal: 'up' },
        { label: 'agency activity', value: topAgency.name || 'Unknown agency', signal: 'up' },
        { label: 'spend changes', value: formatMoneyCompact(topAgency.obligated), signal: 'up' },
        { label: 'competitive shifts', value: `${bundle.incumbentCount} incumbent-linked rows`, signal: bundle.incumbentCount > 0 ? 'alert' : 'steady' },
      ],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/weekly-intel', async (req, res) => {
  try {
    const bundle = await loadClientDeepBundle();
    const rows = (bundle.latestDeadlines || []).slice(0, 12).map((row) => ({
      label: row.notice_id || row.title || 'Opportunity',
      value: `${row.response_date || 'N/A'} • ${row.agency || 'Unknown agency'}`,
    }));
    res.json({ status: 'intel_ready', intel: { weekly_queue: rows } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/feed-summary', async (req, res) => {
  try {
    const bundle = await loadClientSummaryBundle();
    const deep = await loadClientDeepBundle();
    const topNaics = (deep.naicsDensity || []).slice(0, 3).map((row) => row.naics).join(' • ') || 'N/A';
    const avgSemantic = deep.topMatches?.length
      ? ((deep.topMatches.reduce((sum, row) => sum + safeNum(row.semantic_score), 0) / deep.topMatches.length) * 100).toFixed(1) + '%'
      : 'N/A';
    res.json({
      status: 'summary_loaded',
      summary: [
        { label: 'filtered by client NAICS', value: topNaics, signal: 'steady' },
        { label: 'relevance scoring', value: avgSemantic, signal: 'up' },
        { label: 'due dates', value: `${(deep.latestDeadlines || []).length} near-term`, signal: 'alert' },
        { label: 'risk indicators', value: `${bundle.reviewCount} review candidates`, signal: 'steady' },
      ],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/feed-intel', async (req, res) => {
  try {
    const deep = await loadClientDeepBundle();
    const rows = (deep.topMatches || []).slice(0, 15).map((row) => ({
      label: row.opportunity_title || row.opportunity_id || 'Opportunity',
      value: `${row.fpds_naics_code || 'N/A'} • ${toPercent(row.semantic_score || 0)}% semantic`,
    }));
    res.json({ status: 'intel_ready', intel: { opportunity_feed: rows } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/matches-summary', async (req, res) => {
  try {
    const deep = await loadClientDeepBundle();
    const uniqueVendors = new Set((deep.topMatches || []).map((row) => row.incumbent_vendor).filter((v) => v && !/unknown/i.test(String(v))));
    const topStrategy = deep.strategyMix?.[0]?.strategy || 'Unknown';
    res.json({
      status: 'summary_loaded',
      summary: [
        { label: 'matched vendors', value: `${uniqueVendors.size} vendors`, signal: 'up' },
        { label: 'match reasons', value: deep.topMatches?.[0]?.match_reason || 'N/A', signal: 'steady' },
        { label: 'strategy used', value: topStrategy, signal: 'steady' },
        { label: 'competitive density', value: `${(deep.vendorDensity || []).length} vendor lanes`, signal: 'up' },
      ],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/matches-intel', async (req, res) => {
  try {
    const deep = await loadClientDeepBundle();
    const rows = (deep.strategyMix || []).slice(0, 12).map((row) => ({
      label: row.strategy || 'Unknown',
      value: `${safeNum(row.records)} records`,
    }));
    res.json({ status: 'intel_ready', intel: { strategy_breakdown: rows } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/spend-summary', async (req, res) => {
  try {
    const bundle = await loadClientSummaryBundle();
    const topAgency = bundle.topAgencies?.[0] || {};
    const topVendor = bundle.topVendors?.[0] || {};
    res.json({
      status: 'summary_loaded',
      summary: [
        { label: 'agency spend', value: topAgency.name || 'Unknown agency', signal: 'steady' },
        { label: 'vendor spend', value: `${topVendor.name || 'Unknown vendor'} • ${formatMoneyCompact(topVendor.obligated)}`, signal: 'up' },
        { label: 'year-over-year', value: '2019-2026 window', signal: 'steady' },
        { label: 'forecasting signals', value: bundle.highFitCount > 0 ? 'Active' : 'Review', signal: bundle.highFitCount > 0 ? 'up' : 'steady' },
      ],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/spend-intel', async (req, res) => {
  try {
    const deep = await loadClientDeepBundle();
    const agencyRows = (deep.agencyDensity || []).slice(0, 10).map((row) => ({
      label: row.agency || 'Unknown',
      value: `${safeNum(row.records)} records`,
    }));
    const vendorRows = (deep.vendorDensity || []).slice(0, 10).map((row) => ({
      label: row.vendor || 'Unknown',
      value: `${safeNum(row.records)} records • ${formatMoneyCompact(row.spend)}`,
    }));
    res.json({ status: 'intel_ready', intel: { agency_spend_map: agencyRows, vendor_spend_map: vendorRows } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/vendor-summary', async (req, res) => {
  try {
    const bundle = await loadClientSummaryBundle();
    const topVendor = bundle.topVendors?.[0] || {};
    res.json({
      status: 'summary_loaded',
      summary: [
        { label: 'vendor history', value: topVendor.name || 'Unknown vendor', signal: 'steady' },
        { label: 'past awards', value: `${safeNum(topVendor.count)} awards`, signal: 'up' },
        { label: 'modifications', value: `${bundle.totalMatches} tracked references`, signal: 'steady' },
        { label: 'spend footprint', value: formatMoneyCompact(topVendor.obligated), signal: 'up' },
      ],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/vendor-intel', async (req, res) => {
  try {
    const deep = await loadClientDeepBundle();
    const rows = (deep.vendorDensity || []).slice(0, 15).map((row) => ({
      label: row.vendor || 'Unknown',
      value: `${safeNum(row.records)} records • ${formatMoneyCompact(row.spend)}`,
    }));
    res.json({ status: 'intel_ready', intel: { vendor_profiles: rows } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/capture-summary', async (req, res) => {
  try {
    const deep = await loadClientDeepBundle();
    const top3 = (deep.topMatches || []).slice(0, 3).map((row) => row.opportunity_title || row.opportunity_id).filter(Boolean).join(' • ') || 'No top opportunities loaded';
    const topStrategy = (deep.strategyMix || []).slice(0, 3).map((row) => row.strategy).filter(Boolean).join(' • ') || 'No strategy mix loaded';
    const competitiveNotes = (deep.vendorDensity || []).length;
    const dueRows = (deep.latestDeadlines || []).length;

    res.json({
      status: 'summary_loaded',
      summary: [
        { label: 'top 3 opportunities', value: top3, signal: 'up' },
        { label: 'recommended strategy', value: topStrategy, signal: 'steady' },
        { label: 'competitive notes', value: `${competitiveNotes} vendor lanes`, signal: 'steady' },
        { label: 'proposal readiness', value: `${dueRows} dated opportunities`, signal: dueRows > 0 ? 'alert' : 'steady' },
      ],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/capture-intel', async (req, res) => {
  try {
    const focusId = String(req.query.opportunity_id || '').trim();
    if (!focusId) {
      return res.json({
        status: 'summary_only',
        reason: 'missing key fields',
        intel: {
          recommendation_detail: [
            { label: 'next step', value: 'Provide opportunity_id for focused capture recommendations.' },
          ],
        },
      });
    }

    const deep = await loadClientDeepBundle();
    const focus = (deep.topMatches || []).find((row) => String(row.opportunity_id || '').trim() === focusId);

    if (!focus) {
      return res.json({
        status: 'summary_only',
        reason: 'focus opportunity not found in top intelligence window',
        intel: {
          recommendation_detail: [
            { label: 'next step', value: 'Try another opportunity_id or review top opportunities.' },
          ],
        },
      });
    }

    res.json({
      status: 'intel_ready',
      intel: {
        recommendation_detail: [
          { label: 'opportunity', value: focus.opportunity_title || focus.opportunity_id || 'N/A' },
          { label: 'agency', value: focus.fpds_agency || 'Unknown agency' },
          { label: 'semantic score', value: `${toPercent(focus.semantic_score || 0)}%` },
          { label: 'strategy', value: focus.matching_strategy || 'Unknown' },
          { label: 'incumbent', value: focus.incumbent_vendor || 'No incumbent identified' },
        ],
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function splitClientList(value) {
  return String(value || '')
    .split(/[;,|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function lc(value) {
  return String(value || '').toLowerCase();
}

function listIncludesPart(list, value) {
  const target = lc(value);
  if (!target) return false;
  return list.some((item) => target.includes(lc(item)) || lc(item).includes(target));
}

function buildClientOpportunityRows(bundle, context, maxRows = 25) {
  const dueById = new Map(
    (bundle.latestDeadlines || []).map((row) => [String(row.notice_id || '').trim(), row.response_date || null])
  );

  const scored = (bundle.topMatches || []).map((row) => {
    const rowNaics = normalizeNaicsCode(row.fpds_naics_code);
    const rowAgency = String(row.fpds_agency || 'Unknown agency').trim();
    const title = String(row.opportunity_title || row.opportunity_id || 'Opportunity').trim();
    const reasonText = String(row.match_reason || '').trim();
    const keywordText = `${title} ${reasonText}`.toLowerCase();
    const semantic = safeNum(row.semantic_score);

    const naicsMatch = context.naicsList.length > 0 && listIncludesPart(context.naicsList, rowNaics);
    const keywordMatch = context.keywordList.length > 0 && context.keywordList.some((word) => keywordText.includes(lc(word)));
    const agencyMatch = context.agencyList.length > 0 && context.agencyList.some((agency) => lc(rowAgency).includes(lc(agency)));

    let relevance = Math.round(Math.min(1, Math.max(0, semantic)) * 65);
    if (naicsMatch) relevance += 18;
    if (keywordMatch) relevance += 12;
    if (agencyMatch) relevance += 10;
    if ((row.confidence_tier || '').toUpperCase() === 'MEDIUM') relevance += 5;

    relevance = Math.min(100, relevance);

    const riskIndicators = [];
    if (!naicsMatch && context.naicsList.length > 0) riskIndicators.push('NAICS drift');
    if (!keywordMatch && context.keywordList.length > 0) riskIndicators.push('Keyword drift');
    if (!agencyMatch && context.agencyList.length > 0) riskIndicators.push('Agency drift');
    if (!row.incumbent_vendor || lc(row.incumbent_vendor) === 'unknown') riskIndicators.push('Unknown incumbent');

    return {
      opportunity_id: row.opportunity_id,
      title,
      agency: rowAgency || 'Unknown agency',
      psc: normalizePscCode(row.fpds_psc_code) || 'N/A',
      relevance_score: relevance,
      due_date: dueById.get(String(row.opportunity_id || '').trim()) || 'N/A',
      risk_indicators: riskIndicators.length ? riskIndicators.join(', ') : 'None',
      match_confidence: row.confidence_tier || 'LOW',
      semantic_score: semantic,
      matching_strategy: row.matching_strategy || 'Unknown',
      incumbent_vendor: row.incumbent_vendor || 'Unknown',
      match_reason: row.match_reason || 'N/A',
    };
  });

  return scored
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, Math.max(1, maxRows));
}

async function resolveClientContext(req) {
  const query = req.query || {};
  const rawClientId = String(query.client_id || '').trim();

  let clientRecord = null;
  if (rawClientId && /^\d+$/.test(rawClientId)) {
    clientRecord = await getAsync(clientDb, 'SELECT * FROM clients WHERE client_id = ?', [Number(rawClientId)]);
  }

  const naicsList = splitClientList(query.naics || clientRecord?.naics || '');
  const keywordList = splitClientList(query.keywords || clientRecord?.keywords || '');
  const agencyList = splitClientList(query.preferred_agencies || clientRecord?.preferred_agencies || '');

  return {
    clientId: clientRecord?.client_id || null,
    clientRecord,
    naicsList,
    keywordList,
    agencyList,
  };
}

function renderClientSummaryRows(rows) {
  return rows.map((row) => ({
    label: row.label,
    value: row.value,
    signal: row.signal || 'steady',
  }));
}

async function buildClientIntelPayload(module, context, viewMode) {
  const summaryBundle = await loadClientSummaryBundle();
  const deepBundle = await loadClientDeepBundle();
  const rankedRows = buildClientOpportunityRows(deepBundle, context, 25);
  const top = rankedRows[0] || {};

  if (viewMode === 'deep') {
    if (module === 'weekly') {
      return {
        status: 'intel_ready',
        deep: {
          weekly_queue: rankedRows.slice(0, 12).map((row) => ({ label: row.opportunity_id || row.title, value: `${row.title} • ${row.agency}` })),
        },
      };
    }

    if (module === 'opportunities') {
      return {
        status: 'intel_ready',
        deep: {
          opportunity_feed: rankedRows.slice(0, 15).map((row) => ({ label: row.title, value: `Score ${row.relevance_score} • ${row.agency}` })),
        },
        opportunities: rankedRows.slice(0, 10).map((row) => ({
          opportunity_id: row.opportunity_id,
          title: row.title,
          agency: row.agency,
          psc: row.psc,
          relevance_score: row.relevance_score,
          due_date: row.due_date,
          risk_indicators: row.risk_indicators,
          match_confidence: row.match_confidence,
        })),
      };
    }

    if (module === 'matches') {
      const strategyCounts = new Map();
      rankedRows.forEach((row) => {
        const key = row.matching_strategy || 'Unknown';
        strategyCounts.set(key, (strategyCounts.get(key) || 0) + 1);
      });
      const strategyRows = [...strategyCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([strategy, count]) => ({ label: strategy, value: `${count} records` }));

      return { status: 'intel_ready', deep: { strategy_breakdown: strategyRows } };
    }

    if (module === 'spend') {
      const agencyRows = (deepBundle.agencyDensity || []).slice(0, 10).map((row) => ({
        label: row.agency || 'Unknown agency',
        value: `${safeNum(row.records)} records`,
      }));
      const vendorRows = (deepBundle.vendorDensity || []).slice(0, 10).map((row) => ({
        label: row.vendor || 'Unknown vendor',
        value: `${safeNum(row.records)} records • ${formatMoneyCompact(row.spend)}`,
      }));

      return {
        status: 'intel_ready',
        deep: {
          agency_spend_map: agencyRows,
          vendor_spend_map: vendorRows,
        },
      };
    }

    if (module === 'vendors') {
      const rows = (deepBundle.vendorDensity || []).slice(0, 15).map((row) => ({
        label: row.vendor || 'Unknown vendor',
        value: `${safeNum(row.records)} records • ${formatMoneyCompact(row.spend)}`,
      }));
      return { status: 'intel_ready', deep: { vendor_profiles: rows } };
    }

    if (module === 'capture') {
      return {
        status: 'intel_ready',
        deep: {
          recommendation_detail: rankedRows.slice(0, 8).map((row) => ({
            label: row.title,
            value: `Score ${row.relevance_score} • ${row.match_confidence} • ${row.risk_indicators}`,
          })),
        },
      };
    }
  }

  if (module === 'weekly') {
    return {
      status: 'summary_loaded',
      summary: renderClientSummaryRows([
        { label: 'monday refresh summary', value: summaryBundle.lastMatcherRun || 'Unknown', signal: 'steady' },
        { label: 'new opportunities', value: `${rankedRows.length} context-ranked rows`, signal: 'up' },
        { label: 'agency activity', value: top.agency || 'Unknown agency', signal: 'up' },
        { label: 'spend changes', value: formatMoneyCompact(summaryBundle.topAgencies?.[0]?.obligated), signal: 'up' },
      ]),
    };
  }

  if (module === 'opportunities') {
    return {
      status: 'summary_loaded',
      summary: renderClientSummaryRows([
        { label: 'filtered by client NAICS', value: context.naicsList.join(' • ') || 'No client NAICS set', signal: 'steady' },
        { label: 'relevance scoring', value: `${top.relevance_score || 0}%`, signal: 'up' },
        { label: 'due dates', value: `${rankedRows.filter((row) => row.due_date && row.due_date !== 'N/A').length} near-term`, signal: 'alert' },
        { label: 'risk indicators', value: top.risk_indicators || 'None', signal: 'steady' },
      ]),
    };
  }

  if (module === 'matches') {
    const vendors = new Set(rankedRows.map((row) => row.incumbent_vendor).filter((v) => v && lc(v) !== 'unknown'));
    return {
      status: 'summary_loaded',
      summary: renderClientSummaryRows([
        { label: 'matched vendors', value: `${vendors.size} vendors`, signal: 'up' },
        { label: 'match reasons', value: top.match_reason || 'N/A', signal: 'steady' },
        { label: 'strategy used', value: top.matching_strategy || 'Unknown', signal: 'steady' },
        { label: 'competitive density', value: `${(deepBundle.vendorDensity || []).length} vendor lanes`, signal: 'up' },
      ]),
    };
  }

  if (module === 'spend') {
    const topAgency = summaryBundle.topAgencies?.[0] || {};
    const topVendor = summaryBundle.topVendors?.[0] || {};
    return {
      status: 'summary_loaded',
      summary: renderClientSummaryRows([
        { label: 'agency spend', value: topAgency.name || 'Unknown agency', signal: 'steady' },
        { label: 'vendor spend', value: `${topVendor.name || 'Unknown vendor'} • ${formatMoneyCompact(topVendor.obligated)}`, signal: 'up' },
        { label: 'year-over-year', value: '2019-2026 window', signal: 'steady' },
        { label: 'forecasting signals', value: top.relevance_score > 55 ? 'Active' : 'Review', signal: top.relevance_score > 55 ? 'up' : 'steady' },
      ]),
    };
  }

  if (module === 'vendors') {
    const topVendor = summaryBundle.topVendors?.[0] || {};
    return {
      status: 'summary_loaded',
      summary: renderClientSummaryRows([
        { label: 'vendor history', value: topVendor.name || 'Unknown vendor', signal: 'steady' },
        { label: 'past awards', value: `${safeNum(topVendor.count)} awards`, signal: 'up' },
        { label: 'modifications', value: `${summaryBundle.totalMatches} tracked references`, signal: 'steady' },
        { label: 'spend footprint', value: formatMoneyCompact(topVendor.obligated), signal: 'up' },
      ]),
    };
  }

  if (module === 'capture') {
    const top3 = rankedRows.slice(0, 3).map((row) => row.title).join(' • ') || 'No opportunities in context';
    return {
      status: 'summary_loaded',
      summary: renderClientSummaryRows([
        { label: 'top 3 opportunities', value: top3, signal: 'up' },
        { label: 'recommended strategy', value: top.matching_strategy || 'Unknown', signal: 'steady' },
        { label: 'competitive notes', value: `${(deepBundle.vendorDensity || []).length} vendor lanes`, signal: 'steady' },
        { label: 'proposal readiness', value: `${rankedRows.filter((row) => row.due_date && row.due_date !== 'N/A').length} dated opportunities`, signal: 'alert' },
      ]),
    };
  }

  return {
    status: 'summary_loaded',
    summary: [],
  };
}

app.post('/api/clients', async (req, res) => {
  try {
    const client = await createClient(req.body);
    if (!client.id) {
      throw new Error('Client creation did not return an id');
    }
    res.status(201).json({ client });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/client/search', async (req, res) => {
  try {
    const term = String(req.query.term || '').trim();
    if (term.length < 2) {
      return res.json({ clients: [] });
    }

    const like = `%${term}%`;
    const rows = await allAsync(
      clientDb,
      `
        SELECT
          client_id,
          client_name,
          uei,
          duns,
          naics,
          keywords,
          contact_name,
          contact_email,
          contact_phone,
          preferred_agencies,
          past_performance,
          notes,
          created_at
        FROM clients
        WHERE lower(client_name) LIKE lower(?)
          OR lower(COALESCE(uei, '')) LIKE lower(?)
          OR lower(COALESCE(duns, '')) LIKE lower(?)
          OR lower(COALESCE(naics, '')) LIKE lower(?)
          OR lower(COALESCE(keywords, '')) LIKE lower(?)
          OR lower(COALESCE(preferred_agencies, '')) LIKE lower(?)
          OR lower(COALESCE(contact_name, '')) LIKE lower(?)
        ORDER BY client_name ASC
        LIMIT 25
      `,
      [like, like, like, like, like, like, like]
    );

    res.json({ clients: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/intel/:module', async (req, res) => {
  try {
    const module = String(req.params.module || '').trim();
    const allowed = new Set(['weekly', 'opportunities', 'matches', 'spend', 'vendors', 'capture']);
    if (!allowed.has(module)) {
      return res.status(400).json({ error: 'Invalid client intel module' });
    }

    const context = await resolveClientContext(req);
    if (!context.clientId) {
      return res.status(400).json({ error: 'client_id is required for client intel endpoints' });
    }

    const viewMode = String(req.query.view || 'summary').toLowerCase() === 'deep' ? 'deep' : 'summary';
    const payload = await buildClientIntelPayload(module, context, viewMode);

    res.json({
      ...payload,
      context: {
        client_id: context.clientId,
        naics: context.naicsList,
        keywords: context.keywordList,
        preferred_agencies: context.agencyList,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/intel/opportunity/:opp_id', async (req, res) => {
  try {
    const context = await resolveClientContext(req);
    if (!context.clientId) {
      return res.status(400).json({ error: 'client_id is required for opportunity intel' });
    }

    const oppId = String(req.params.opp_id || '').trim();
    if (!oppId) {
      return res.status(400).json({ error: 'opportunity id is required' });
    }

    const bundle = await loadClientDeepBundle();
    const rankedRows = buildClientOpportunityRows(bundle, context, 50);
    const focus = rankedRows.find((row) => String(row.opportunity_id || '').trim() === oppId);

    if (!focus) {
      return res.json({
        status: 'summary_only',
        intel: {
          vendor_density: 'N/A',
          incumbent_gravity: 'N/A',
          spend_footprint: 'N/A',
          award_history: 'N/A',
          risk_indicators: 'Opportunity not found in current ranked context',
          strategy_recommendations: 'Search and select a valid opportunity from top opportunities panel.',
        },
      });
    }

    const relatedVendor = (bundle.vendorDensity || []).find((row) => lc(row.vendor) === lc(focus.incumbent_vendor));
    const relatedAgency = (bundle.agencyDensity || []).find((row) => lc(row.agency) === lc(focus.agency));

    res.json({
      status: 'intel_ready',
      intel: {
        vendor_density: relatedVendor ? `${safeNum(relatedVendor.records)} vendor records` : 'No direct vendor density row',
        incumbent_gravity: focus.incumbent_vendor || 'No incumbent identified',
        spend_footprint: relatedVendor ? formatMoneyCompact(relatedVendor.spend) : 'N/A',
        award_history: relatedAgency ? `${safeNum(relatedAgency.records)} agency-linked records` : 'N/A',
        risk_indicators: focus.risk_indicators,
        strategy_recommendations: `${focus.matching_strategy || 'Unknown strategy'} | ${focus.match_confidence} confidence | relevance ${focus.relevance_score}%`,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/:id', async (req, res) => {
  try {
    const id = Number.parseInt(String(req.params.id || ''), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid client id' });
    }

    const row = await getAsync(clientDb, 'SELECT * FROM clients WHERE client_id = ?', [id]);
    if (!row) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/grants', async (req, res) => {
  try {
    const rawLimit = String(req.query.limit || '50');
    const limit = rawLimit === 'all'
      ? Number.MAX_SAFE_INTEGER
      : Math.min(Number.parseInt(rawLimit, 10) || 50, 5000);
    const offset = Math.max(Number.parseInt(String(req.query.offset || '0'), 10) || 0, 0);

    res.json(await listGrants({ limit, offset }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/grants/:oppNum/signals', async (req, res) => {
  try {
    const signals = await getGrantSignals(String(req.params.oppNum || ''));
    if (!signals) {
      return res.status(404).json({ error: 'Grant not found' });
    }
    res.json(signals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/grants/intelligence', (req, res) => res.json({ items: [] }));
app.get('/api/grants/opportunities', (req, res) => res.json({ items: [] }));

app.get('/api/grants/:oppNum', async (req, res) => {
  try {
    const grant = await getGrantDetail(String(req.params.oppNum || ''));
    if (!grant) {
      return res.status(404).json({ error: 'Grant not found' });
    }
    res.json({ grant });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/grant-engine', (req, res) => {
  const content = `
    <div class="dashboard-shell">
      <section class="page-hero">
        <p class="page-kicker">JE ROCKER Grant Layer</p>
        <h1 class="page-hero-title">Grant Engine</h1>
        <p class="page-hero-subtitle">Federal grant opportunities from Simpler.Grants.gov, enriched with Grants.gov detail.</p>
      </section>

      <section id="grant-engine" class="polish-panel polish-panel-expanded">
        <div class="polish-panel-body">Loading grants…</div>
      </section>
    </div>
    <script src="/src/grants/grants_list.js"></script>
    <script>
      (function () {
        window.GrantList.mountGrantsList(document.getElementById('grant-engine'));
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Grant Engine', content }));
});

app.get('/grant/:oppNum', (req, res) => {
  const content = `
    <div class="dashboard-shell">
      <section class="page-hero">
        <p class="page-kicker">JE ROCKER Grant Layer</p>
        <h1 class="page-hero-title">Grant Detail</h1>
      </section>

      <section id="grant-detail" class="polish-panel polish-panel-expanded" data-opp-num="${String(req.params.oppNum).replace(/"/g, '&quot;')}">
        <div class="polish-panel-body">Loading grant detail…</div>
      </section>
    </div>
    <script src="/src/grants/grants_list.js"></script>
    <script src="/src/grants/grants_detail.js"></script>
    <script>
      (function () {
        const host = document.getElementById('grant-detail');
        window.GrantDetail.mountGrantDetail(host, host.dataset.oppNum);
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Grant Detail', content }));
});

app.get('/', (req, res) => {
  res.redirect('/cover');
});

app.get('/cover', (req, res) => {
  const content = `
    <section class="hero cover-hero-container">
      <h1 class="cover-hero-title">JE ROCKER LC</h1>
      <div class="cover-hero-underline" aria-hidden="true"></div>
      <p class="cover-hero-tagline">Federal Business Consulting & Contract Intelligence</p>
      <p class="cover-hero-microtagline">Powered by the JE ROCKER Intelligence Engine</p>
      <div class="hero-actions cover-hero-buttons">
        <a class="cover-button" href="/primary-dashboard">Primary Dashboard</a>
        <a class="cover-button" href="/client-dashboard">Client Dashboard</a>
        <a class="cover-button" href="/business-driver">Business Driver Page</a>
      </div>
      <div class="cover-divider-band" aria-hidden="true"></div>
      <section class="cover-grid-block">
      <div class="cover-info-grid" id="coverInfoGrid">
        <article class="cover-info-card" data-card-id="who" role="button" tabindex="0" aria-expanded="false">
          <div class="cover-card-header"><span class="cover-info-card-icon">🏛️</span><h3>Who We Are</h3></div>
          <p>Federal business consultants translating procurement complexity into practical decisions.</p>
          <div class="cover-card-expand-wrap">
            <div class="cover-card-expand">
              <p>JE ROCKER LC is a federal business consulting firm powered by contract intelligence.</p>
              <ul>
                <li>Consulting-first advisory model for federal market entry</li>
                <li>Data-driven assessment of opportunity fit and timing</li>
                <li>Designed for small business execution speed</li>
              </ul>
              <button class="cover-collapse-btn" type="button">Collapse</button>
            </div>
          </div>
        </article>

        <article class="cover-info-card" data-card-id="deliver" role="button" tabindex="0" aria-expanded="false">
          <div class="cover-card-header"><span class="cover-info-card-icon">📊</span><h3>What We Deliver</h3></div>
          <p>Weekly intelligence and capture guidance focused on actionable pursuit decisions.</p>
          <div class="cover-card-expand-wrap">
            <div class="cover-card-expand">
              <p>Weekly intelligence, opportunity interpretation, capture strategy, competitive landscape, spend analysis, and proposal readiness.</p>
              <ul>
                <li>Opportunity interpretation with match-context signals</li>
                <li>Competitive and spend landscape snapshots</li>
                <li>Proposal readiness checkpoints and task framing</li>
              </ul>
              <button class="cover-collapse-btn" type="button">Collapse</button>
            </div>
          </div>
        </article>

        <article class="cover-info-card" data-card-id="works" role="button" tabindex="0" aria-expanded="false">
          <div class="cover-card-header"><span class="cover-info-card-icon">⚙️</span><h3>How It Works</h3></div>
          <p>A recurring engine pipeline that refreshes signals and produces consulting-ready outputs.</p>
          <div class="cover-card-expand-wrap">
            <div class="cover-card-expand">
              <p>Our engine refreshes weekly, analyzes federal opportunities, matches vendors, and generates actionable insights.</p>
              <ul>
                <li>Weekly ingestion and normalization cycle</li>
                <li>Automated matching and confidence scoring</li>
                <li>Decision-ready outputs for internal and client dashboards</li>
              </ul>
              <button class="cover-collapse-btn" type="button">Collapse</button>
            </div>
          </div>
        </article>

        <article class="cover-info-card" data-card-id="matters" role="button" tabindex="0" aria-expanded="false">
          <div class="cover-card-header"><span class="cover-info-card-icon">🎯</span><h3>Why It Matters</h3></div>
          <p>Small businesses need clarity on agency behavior to compete with focus and confidence.</p>
          <div class="cover-card-expand-wrap">
            <div class="cover-card-expand">
              <p>We help small businesses understand federal buying behavior, identify real opportunities, and compete with confidence.</p>
              <ul>
                <li>Reduce noise and prioritize realistic pursuits</li>
                <li>Improve timing with agency and vendor behavior context</li>
                <li>Support disciplined capture planning under resource constraints</li>
              </ul>
              <button class="cover-collapse-btn" type="button">Collapse</button>
            </div>
          </div>
        </article>
      </div>
      </section>
    </section>
    <p class="cover-footer-tagline">JE ROCKER LC • Federal Consulting Powered by Technology</p>
    <div class="footer-links">
      <span>About</span><span>Contact</span><span>Privacy</span><span>Terms</span>
    </div>
    <script>
      (() => {
        const cards = Array.from(document.querySelectorAll('.cover-info-card'));
        let expandedId = null;

        const collapseCard = (card) => {
          card.classList.remove('cover-info-card-expanded');
          card.setAttribute('aria-expanded', 'false');
          const expand = card.querySelector('.cover-card-expand');
          if (expand) expand.classList.remove('is-open');
        };

        const expandCard = (card) => {
          card.classList.add('cover-info-card-expanded');
          card.setAttribute('aria-expanded', 'true');
          const expand = card.querySelector('.cover-card-expand');
          if (expand) expand.classList.add('is-open');
        };

        const openOnly = (cardId) => {
          expandedId = cardId;
          cards.forEach((card) => {
            const isTarget = card.getAttribute('data-card-id') === cardId;
            if (isTarget) {
              expandCard(card);
            } else {
              collapseCard(card);
            }
          });
        };

        cards.forEach((card) => {
          const cardId = card.getAttribute('data-card-id');
          card.addEventListener('click', () => {
            openOnly(cardId);
          });
          card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openOnly(cardId);
            }
          });
          const collapseBtn = card.querySelector('.cover-collapse-btn');
          if (collapseBtn) {
            collapseBtn.addEventListener('click', (event) => {
              event.stopPropagation();
              expandedId = null;
              collapseCard(card);
            });
          }
        });
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Cover', content, includeNav: false }));
});

app.get('/business-driver', (req, res) => {
  const content = `
    <div class="business-driver-container">
      <aside class="bd-left-rail">
        <h3 class="bd-left-rail-title">Quick Links</h3>
        <a class="bd-left-rail-link" href="https://sam.gov" target="_blank" rel="noreferrer"><span>🏛️</span><span>SAM.gov</span></a>
        <a class="bd-left-rail-link" href="https://www.fpds.gov" target="_blank" rel="noreferrer"><span>📑</span><span>FPDS / FPDS-NG</span></a>
        <a class="bd-left-rail-link" href="https://www.usaspending.gov" target="_blank" rel="noreferrer"><span>💵</span><span>USAspending.gov</span></a>
        <a class="bd-left-rail-link" href="https://www.acquisition.gov" target="_blank" rel="noreferrer"><span>📘</span><span>Acquisition.gov</span></a>
        <a class="bd-left-rail-link" href="#"><span>🛰️</span><span>Agency Forecasts</span></a>
        <a class="bd-left-rail-link" href="https://www.sba.gov/federal-contracting/contracting-guide/size-standards" target="_blank" rel="noreferrer"><span>📏</span><span>SBA Size Standards</span></a>
        <a class="bd-left-rail-link" href="/cover"><span>🏠</span><span>JE ROCKER LC Cover Page</span></a>
        <a class="bd-left-rail-link" href="/primary-dashboard"><span>📊</span><span>Primary Dashboard</span></a>
        <a class="bd-left-rail-link" href="/client-dashboard"><span>🤝</span><span>Client Dashboard</span></a>
      </aside>

      <main>
        <h2 style="margin-top: 0;">Business Driver - Internal Cockpit</h2>

        <section class="bd-top-cluster">
          <div class="bd-top-cluster-item">🟢 <strong>engine_status</strong>: <span id="cluster-engine-status">Ready</span></div>
          <div class="bd-top-cluster-item">🕒 <strong>last_scraper_run</strong>: <span id="cluster-last-scraper">N/A</span></div>
          <div class="bd-top-cluster-item">⚙️ <strong>last_matcher_run</strong>: <span id="cluster-last-matcher">N/A</span></div>
          <div class="bd-top-cluster-item">📅 <strong>next_refresh</strong>: Next refresh: Scheduled</div>
          <div class="bd-top-cluster-item">💚 <strong>system_health</strong>: <span id="cluster-system-health">Healthy</span></div>
        </section>

        <div class="cover-divider-band" aria-hidden="true"></div>

        <section class="bd-command-console">
          <div class="search-row">
            <input id="internalSearchInput" class="bd-search-input" type="text" placeholder="Search internal data: agencies, vendors, NAICS, PSC, opportunity ID, award ID, keywords, fiscal years" />
            <button id="internalSearchBtn" type="button">Search</button>
          </div>
          <div class="bd-search-filters">Filters: agencies • vendors • NAICS • PSC • FY • keywords</div>
          <div id="bdSearchHistory" class="bd-search-history">History: none yet</div>
        </section>

        <div class="cover-divider-band" aria-hidden="true"></div>

        <section class="bd-cockpit-grid">
          <section class="bd-panel" id="panel-ingestion">
            <button class="bd-panel-header" type="button"><span class="bd-panel-header-icon">🧪</span><span>Ingestion Status</span><span style="margin-left:auto; opacity:.78;">Engine Health Module</span></button>
            <div class="bd-panel-body">
              <div class="kv"><span>total opportunities</span><span id="ingestion-total-opportunities">Loading...</span></div>
              <div class="kv"><span>last scraper run</span><span id="ingestion-last-scraper-run">Loading...</span></div>
              <div class="kv"><span>last matcher run</span><span id="ingestion-last-matcher-run">Loading...</span></div>
              <div class="kv"><span>pipeline status</span><span id="ingestion-pipeline-status">Loading...</span></div>
              <p class="bd-panel-extra" hidden>Expanded module view: ingestion diagnostics and cycle checks.</p>
            </div>
          </section>

          <section class="bd-panel" id="panel-metrics">
            <button class="bd-panel-header" type="button"><span class="bd-panel-header-icon">📡</span><span>Engine Metrics</span><span style="margin-left:auto; opacity:.78;">Telemetry Module</span></button>
            <div class="bd-panel-body">
              <div class="kv"><span>total matches</span><span id="engine-total-matches">Loading...</span></div>
              <div class="kv"><span>matched opportunities</span><span id="engine-matched-opportunities">Loading...</span></div>
              <div class="kv"><span>match coverage</span><span id="engine-match-coverage">Loading...</span></div>
              <div class="kv"><span>forecasting signals</span><span id="engine-forecasting-signals">Loading...</span></div>
              <p class="bd-panel-extra" hidden>Expanded module view: confidence and forecast signal context.</p>
            </div>
          </section>

          <section class="bd-panel" id="panel-spend">
            <button class="bd-panel-header" type="button"><span class="bd-panel-header-icon">⛽</span><span>Spend Status</span><span style="margin-left:auto; opacity:.78;">Systems/Fuel Module</span></button>
            <div class="bd-panel-body">
              <div class="kv"><span>spend ingestion status</span><span id="spend-spend-ingestion-status">Loading...</span></div>
              <div class="kv"><span>years loaded (2019-2026)</span><span id="spend-years-loaded-2019-2026">Loading...</span></div>
              <div class="kv"><span>vendor updates</span><span id="spend-vendor-updates">Loading...</span></div>
              <div class="kv"><span>agency spend updates</span><span id="spend-agency-spend-updates">Loading...</span></div>
              <p class="bd-panel-extra" hidden>Expanded module view: spend synchronization and quality checks.</p>
            </div>
          </section>

          <section class="bd-panel bd-panel-expanded" id="panel-hud">
            <button class="bd-panel-header" type="button"><span class="bd-panel-header-icon">🧭</span><span>Search Results</span><span style="margin-left:auto; opacity:.78;">HUD Module</span></button>
            <div class="bd-panel-body">
              <div id="searchResultType" class="intel-count">Run a search to classify results.</div>
              <div id="searchResults" class="search-results-grid"><div class="result-empty">Search results will render as cards here.</div></div>
              <p class="bd-panel-extra">Expanded module view: interpreted result snippets and cross-links.</p>
            </div>
          </section>

          <section class="bd-panel" id="panel-agency-radar">
            <button class="bd-panel-header" type="button"><span class="bd-panel-header-icon">🛰️</span><span>Agency Spend Trends</span><span style="margin-left:auto; opacity:.78;">Agency Radar Module</span></button>
            <div class="bd-panel-body" id="agencyRadarBody">
              <p>Loading agency radar...</p>
              <p class="bd-panel-extra" hidden>Expanded module view: trend movement and concentration signals.</p>
            </div>
          </section>

          <section class="bd-panel" id="panel-vendor-radar">
            <button class="bd-panel-header" type="button"><span class="bd-panel-header-icon">📈</span><span>Vendor Activity</span><span style="margin-left:auto; opacity:.78;">Vendor Radar Module</span></button>
            <div class="bd-panel-body" id="vendorRadarBody">
              <p>Loading vendor radar...</p>
              <p class="bd-panel-extra" hidden>Expanded module view: vendor shifts and modification activity.</p>
            </div>
          </section>
        </section>
      </main>

      <aside class="bd-right-rail">
        <section class="bd-right-rail-panel">
          <h3 class="bd-right-rail-title">My Stats (Pilot Status Module)</h3>
          <div class="bd-right-rail-body">
            <div class="kv"><span>searches_today</span><span id="founder-searches-today">0</span></div>
            <div class="kv"><span>opportunities_reviewed</span><span id="founder-opportunities-reviewed">0</span></div>
            <div class="kv"><span>clients_touched</span><span id="founder-clients-touched">0</span></div>
            <div class="kv"><span>ingestion_checks</span><span id="founder-ingestion-checks">0</span></div>
            <p>Your activity inside the JE ROCKER engine.</p>
          </div>
        </section>

        <section class="bd-right-rail-panel">
          <h3 class="bd-right-rail-title">Client Stats (Client Intelligence Module)</h3>
          <div class="bd-right-rail-body">
            <div class="kv"><span>active_clients</span><span id="client-active-clients">0</span></div>
            <div class="kv"><span>open_opportunities_for_clients</span><span id="client-open-opportunities">0</span></div>
            <div class="kv"><span>proposals_in_progress</span><span id="client-proposals-progress">0</span></div>
            <p>Snapshot of client-facing work.</p>
          </div>
        </section>

        <section class="bd-right-rail-panel">
          <h3 class="bd-right-rail-title">To-Do List (Mission Checklist Module)</h3>
          <div class="bd-right-rail-body bd-todo-list">
            <label class="bd-todo-item"><input type="checkbox" /><span>Review new matched opportunities</span></label>
            <label class="bd-todo-item"><input type="checkbox" /><span>Update client intelligence summaries</span></label>
            <label class="bd-todo-item"><input type="checkbox" /><span>Check agency spend trends</span></label>
            <label class="bd-todo-item"><input type="checkbox" /><span>Prepare weekly briefing</span></label>
          </div>
        </section>

        <section class="bd-right-rail-panel">
          <h3 class="bd-right-rail-title">Founder Tracks</h3>
          <div class="bd-right-rail-body">
            <article class="bd-track-panel">
              <button class="bd-track-title" data-track-id="track1" type="button">Track 1 - GovTech Ingestion Engine</button>
              <div class="bd-track-body" data-track-body="track1">
                <p>Keep ingestion quality high and weekly refreshes consistent.</p>
                <ul>
                  <li>Tighten opportunity extraction fidelity</li>
                  <li>Validate match confidence drift each cycle</li>
                  <li>Improve suppression precision by agency context</li>
                </ul>
              </div>
            </article>

            <article class="bd-track-panel">
              <button class="bd-track-title" data-track-id="track2" type="button">Track 2 - Client Intelligence & Consulting</button>
              <div class="bd-track-body" data-track-body="track2" hidden>
                <p>Translate signals into practical guidance for clients.</p>
                <ul>
                  <li>Convert raw results into executive-ready summaries</li>
                  <li>Prioritize opportunities by readiness and fit</li>
                  <li>Build repeatable weekly briefing cadence</li>
                </ul>
              </div>
            </article>

            <article class="bd-track-panel">
              <button class="bd-track-title" data-track-id="track3" type="button">Track 3 - Elder Independence Concierge</button>
              <div class="bd-track-body" data-track-body="track3" hidden>
                <p>Maintain strategy framing and roadmap checkpoints.</p>
                <ul>
                  <li>Document pilot workflows and service boundaries</li>
                  <li>Identify strategic partners and integration needs</li>
                  <li>Track compliance and policy requirements</li>
                </ul>
              </div>
            </article>

            <article class="bd-track-panel">
              <button class="bd-track-title" data-track-id="track4" type="button">Track 4 - National Health ID System</button>
              <div class="bd-track-body" data-track-body="track4" hidden>
                <p>Research alignment opportunities and program pathways.</p>
                <ul>
                  <li>Map federal stakeholders and policy levers</li>
                  <li>Monitor related modernization solicitations</li>
                  <li>Develop phased concept narrative</li>
                </ul>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>
    <script>
      const searchHistory = [];
      let activeSearchController = null;
      const input = document.getElementById('internalSearchInput');
      const button = document.getElementById('internalSearchBtn');
      const typeEl = document.getElementById('searchResultType');
      const resultEl = document.getElementById('searchResults');
      const historyEl = document.getElementById('bdSearchHistory');
      const agencyRadarBody = document.getElementById('agencyRadarBody');
      const vendorRadarBody = document.getElementById('vendorRadarBody');

      function renderHistory() {
        if (!searchHistory.length) {
          historyEl.textContent = 'History: none yet';
          return;
        }
              last_scraper_run: pipelineScraperRun || latestOppRow?.last_scraper_run || 'Unknown',
              last_matcher_run: pipelineMatcherRun || latestMatchRow?.last_matcher_run || 'Unknown',

      function setKv(target, rows) {
        target.innerHTML = rows.map((row) => {
          const label = row.name || row.code || row.notice_id || row.opportunity_id || 'item';
          const value = row.obligated || row.count || row.title || row.agency || row.opportunity_title || row.url || 'N/A';
          const metric = Number(row.obligated || row.count || 0);
          const spark = sparklineBars(metric > 0 ? [metric * 0.35, metric * 0.6, metric] : [1, 2, 3], 'teal');
          return '<div class="kv kv-with-spark"><span>' + String(label) + '</span><span><span>' + String(value) + '</span>' + spark + '</span></div>';
        }).join('') || '<p>No data available.</p>';
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function sparklineBars(values, tone) {
        const max = Math.max(...values, 1);
        const bars = values.map((value) => {
          const height = Math.max(20, Math.round((value / max) * 100));
          return '<span class="sparkline-bar ' + (tone === 'amber' ? 'is-amber' : 'is-teal') + '" style="height:' + height + '%"></span>';
        }).join('');
        return '<span class="mini-sparkline">' + bars + '</span>';
      }

      function resultCard(title, type, rows) {
        const drawer = rows.map((row) => '<div class="kv"><span>' + escapeHtml(row.label) + '</span><span>' + escapeHtml(row.value) + '</span></div>').join('');
        const lines = rows.map((row) => '<div class="kv"><span>' + escapeHtml(row.label) + '</span><span>' + escapeHtml(row.value) + '</span></div>').join('');
        return '<article class="result-card" tabindex="0" role="button" aria-expanded="false"><div class="result-card-type">' + escapeHtml(type) + '</div><h4 class="result-card-title">' + escapeHtml(title) + '</h4>' + lines + '<div class="result-card-drawer" hidden><div class="result-card-drawer-inner">' + drawer + '<div class="result-card-tags"><span class="result-tag">detail</span><span class="result-tag">live</span><span class="result-tag">internal</span></div></div></div></article>';
      }

      function normalizeRows(type, rows) {
        if (!rows) return [];
        if (type === 'opportunity' && typeof rows === 'object') {
          const opportunityCards = (rows.opportunities || []).slice(0, 3).map((row) => resultCard(
            row.title || row.notice_id || 'Opportunity',
            'Opportunity',
            [
              { label: 'notice_id', value: row.notice_id || 'N/A' },
              { label: 'agency', value: row.agency || 'N/A' },
              { label: 'due_date', value: row.response_date || 'N/A' },
              { label: 'naics', value: row.naics_code || row.naics_description || 'N/A' },
            ]
          ));
          const matchCards = (rows.matches || []).slice(0, 3).map((row) => resultCard(
            row.opportunity_title || row.opportunity_id || 'Match',
            'Match',
            [
              { label: 'opportunity_id', value: row.opportunity_id || 'N/A' },
              { label: 'agency', value: row.fpds_agency || 'N/A' },
              { label: 'confidence', value: row.confidence_tier || 'N/A' },
              { label: 'semantic', value: row.semantic_score || 'N/A' },
            ]
          ));
          return [...opportunityCards, ...matchCards];
        }

        const list = Array.isArray(rows) ? rows : [];
        return list.slice(0, 6).map((row) => {
          const title = row.name || row.code || row.notice_id || row.fpds_contract_id || row.opportunity_title || 'Result';
          const typeLabel = row.bucket || type;
          const kvRows = Object.entries(row)
            .filter(([key]) => !['bucket', 'name', 'code', 'notice_id', 'fpds_contract_id', 'opportunity_title'].includes(key))
            .slice(0, 4)
            .map(([key, value]) => ({ label: key, value: value ?? 'N/A' }));
          return resultCard(title, typeLabel, kvRows.length ? kvRows : [{ label: 'value', value: 'N/A' }]);
        });
      }

      function renderSearchCards(payload) {
        const cards = normalizeRows(payload.type, payload.rows);
        resultEl.innerHTML = cards.length ? cards.join('') : '<div class="result-empty">No matching internal records found.</div>';
        const renderedCards = Array.from(resultEl.querySelectorAll('.result-card'));
        renderedCards.forEach((card) => {
          const toggle = () => {
            const open = card.classList.contains('result-card-expanded');
            renderedCards.forEach((candidate) => {
              candidate.classList.remove('result-card-expanded');
              candidate.setAttribute('aria-expanded', 'false');
              const drawer = candidate.querySelector('.result-card-drawer');
              if (drawer) drawer.hidden = true;
            });
            if (!open) {
              card.classList.add('result-card-expanded');
              card.setAttribute('aria-expanded', 'true');
              const drawer = card.querySelector('.result-card-drawer');
              if (drawer) drawer.hidden = false;
            }
          };
          card.addEventListener('click', toggle);
          card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggle();
            }
          });
        });
      }

      async function runSearch() {
        const q = (input.value || '').trim();
        if (!q) {
          typeEl.textContent = 'Enter a search term.';
          resultEl.innerHTML = '<div class="result-empty">Search results will render as cards here.</div>';
          return;
        }

        if (q.length < 2) {
          typeEl.textContent = 'Enter at least 2 characters.';
          resultEl.innerHTML = '<div class="result-empty">Search results will render as cards here.</div>';
          return;
        }

        if (activeSearchController) {
          activeSearchController.abort();
        }
        activeSearchController = new AbortController();

        button.disabled = true;
        typeEl.textContent = 'Searching...';
        resultEl.innerHTML = '<div class="result-empty">Running internal search...</div>';

        try {
          const res = await fetch('/api/internal_search?q=' + encodeURIComponent(q), {
            signal: activeSearchController.signal,
            cache: 'no-store',
          });
          if (!res.ok) throw new Error('Search request failed');
          const data = await res.json();

          if (!searchHistory.includes(q)) {
            searchHistory.unshift(q);
          } else {
            const idx = searchHistory.indexOf(q);
            searchHistory.splice(idx, 1);
            searchHistory.unshift(q);
          }
          while (searchHistory.length > 5) searchHistory.pop();
          renderHistory();

          typeEl.textContent = 'Result Type: ' + (data.type || 'unknown');
          renderSearchCards(data);
        } catch (error) {
          if (error && error.name === 'AbortError') {
            return;
          }
          typeEl.textContent = 'Search unavailable';
          resultEl.innerHTML = '<div class="result-empty">Search failed. Try again.</div>';
        } finally {
          button.disabled = false;
        }
      }

      button.addEventListener('click', runSearch);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

      document.querySelectorAll('.bd-panel-header').forEach((header) => {
        header.addEventListener('click', () => {
          const panel = header.closest('.bd-panel');
          const currentlyExpanded = panel.classList.contains('bd-panel-expanded');

          document.querySelectorAll('.bd-panel').forEach((p) => {
            p.classList.remove('bd-panel-expanded');
            const extra = p.querySelector('.bd-panel-extra');
            if (extra) extra.hidden = true;
          });

          if (!currentlyExpanded) {
            panel.classList.add('bd-panel-expanded');
            const extra = panel.querySelector('.bd-panel-extra');
            if (extra) extra.hidden = false;
          }
        });
      });

      document.querySelectorAll('.bd-track-title').forEach((trackBtn) => {
        trackBtn.addEventListener('click', () => {
          const targetId = trackBtn.getAttribute('data-track-id');
          document.querySelectorAll('[data-track-body]').forEach((body) => {
            body.hidden = body.getAttribute('data-track-body') !== targetId || !body.hidden;
          });
        });
      });

      const hydrateBusinessDriverData = () => {
        Promise.all([
          fetch('/api/dashboard_summary', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/intel/agencies?limit=25', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/intel/vendors?limit=5', { cache: 'no-store' }).then((r) => r.json()),
        ]).then(([d, agencyRows, vendorRows]) => {
          const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
          };

          setText('ingestion-total-opportunities', d.total_opportunities ?? 'N/A');
          setText('ingestion-last-scraper-run', d.last_scraper_run ?? 'N/A');
          setText('ingestion-last-matcher-run', d.last_matcher_run ?? 'N/A');
          setText('ingestion-pipeline-status', d.pipeline_status ?? 'N/A');

          setText('spend-spend-ingestion-status', d.spend_ingestion_status ?? 'N/A');
          setText('spend-years-loaded-2019-2026', d.years_loaded ?? 'N/A');
          setText('spend-vendor-updates', d.vendor_updates ?? 'N/A');
          setText('spend-agency-spend-updates', d.agency_spend_updates ?? 'N/A');

          setText('engine-total-matches', d.total_matches ?? 'N/A');
          setText('engine-matched-opportunities', d.matched_opportunities ?? 'N/A');
          setText('engine-match-coverage', d.match_coverage ?? 'N/A');
          setText('engine-forecasting-signals', d.forecasting_signals ?? 'N/A');

          setText('cluster-engine-status', d.pipeline_status ?? 'Ready');
          setText('cluster-last-scraper', d.last_scraper_run ?? 'N/A');
          setText('cluster-last-matcher', d.last_matcher_run ?? 'N/A');

          const health = (d.pipeline_status === 'Ready' && (d.forecasting_signals || 'Active') !== 'Down') ? 'Healthy' : 'Check';
          setText('cluster-system-health', health);

          setKv(agencyRadarBody, Array.isArray(agencyRows) ? agencyRows.slice(0, 5) : []);
          setKv(vendorRadarBody, Array.isArray(vendorRows) ? vendorRows.slice(0, 5) : []);

          const agencies = new Set((agencyRows || []).map((row) => row.name || row.agency).filter(Boolean));
          const reviewed = Number(d.total_matches || 0);
          const highFit = Number(d.matched_opportunities || 0);
          const searchesToday = searchHistory.length;
          setText('founder-searches-today', searchesToday);
          setText('founder-opportunities-reviewed', reviewed);
          setText('founder-clients-touched', Math.min(agencies.size, 5));
          setText('founder-ingestion-checks', d.pipeline_status === 'Ready' ? 1 : 0);
          setText('client-active-clients', Math.min(agencies.size, 5));
          setText('client-open-opportunities', reviewed);
          setText('client-proposals-progress', highFit);

          const clusterItems = document.querySelectorAll('.bd-top-cluster-item');
          const sparkValues = [
            [1, 2, 3],
            [1, 3, 2],
            [2, 3, 4],
            [2, 2, 3],
            [3, 4, 4],
          ];
          clusterItems.forEach((item, idx) => {
            if (!item.querySelector('.mini-sparkline')) {
              item.insertAdjacentHTML('beforeend', sparklineBars(sparkValues[idx] || [1, 2, 3], idx === 4 ? 'amber' : 'teal'));
            }
          });
        }).catch(() => {
          agencyRadarBody.innerHTML = '<p>No agency radar data available.</p>';
          vendorRadarBody.innerHTML = '<p>No vendor radar data available.</p>';
        });
      };

      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(hydrateBusinessDriverData, { timeout: 1000 });
      } else {
        setTimeout(hydrateBusinessDriverData, 0);
      }

      renderHistory();
    </script>
  `;

  res.send(htmlLayout({ title: 'JE ROCKER LC - Business Driver', content }));
});

const PRIMARY_PIPELINE_ENDPOINTS = [
  '/api/pipeline/matched',
  '/api/pipeline/ingested',
  '/api/mission/today',
  '/api/pulse/state',
];

PRIMARY_PIPELINE_ENDPOINTS.forEach((endpoint) => {
  app.get(endpoint, (req, res) => res.json({ items: [] }));
});

app.get('/primary-dashboard', (req, res) => {
  const content = `
    <div id="status-strip" class="primary-status-strip" aria-live="polite">Loading Primary Dashboard status...</div>

    <main class="primary-blueprint">
      <div class="primary-container">
        <section class="panel panel-left">
          <h2>Opportunity Pipeline</h2>

          <h3>Matched Opportunities</h3>
          <div id="matched-opportunities" class="feed">Loading matched opportunities...</div>

          <h3>Ingested Opportunities</h3>
          <div id="ingested-opportunities" class="feed">Loading ingested opportunities...</div>

          <h3>Grant Engine Intelligence</h3>
          <div id="grant-intelligence" class="feed">Loading grant intelligence...</div>

          <h3>Grant Opportunity Zone</h3>
          <div id="grant-opportunities" class="feed">Loading grant opportunities...</div>
        </section>

        <section class="panel panel-middle">
          <h2>Daily Mission</h2>
          <div id="daily-mission" class="feed">Loading daily mission...</div>
        </section>

        <section class="panel panel-right">
          <h2>Pulse</h2>
          <div id="pulse-state" class="feed">Loading system pulse...</div>
        </section>
      </div>

      <div class="indicators-container" aria-label="Engine indicators">
        <div><div id="scraper-indicator" class="indicator"></div><span>Scraper</span></div>
        <div><div id="matcher-indicator" class="indicator"></div><span>Matcher</span></div>
        <div><div id="engine-indicator" class="indicator"></div><span>Engine</span></div>
        <div><div id="cluster-indicator" class="indicator"></div><span>Cluster</span></div>
      </div>

      <div id="cluster-banner" aria-live="polite">Loading cluster roles...</div>
    </main>

    <footer class="primary-blueprint-footer">JE ROCKER LC • GovTech Intelligence Platform</footer>

    <script>
      (() => {
        const setText = (id, value) => {
          const element = document.getElementById(id);
          if (element) element.textContent = value;
        };
        const setIndicator = (id, active) => {
          const element = document.getElementById(id);
          if (element) element.classList.toggle('indicator-active', active);
        };
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderList = (id, items) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = items && items.length
            ? items.map((item) => '<article class="primary-feed-item">' + escapeHtml(typeof item === 'string' ? item : item.title || JSON.stringify(item)) + '</article>').join('')
            : '<p class="primary-feed-empty">No items available.</p>';
        };
        const load = async (endpoint, target) => {
          try {
            const response = await fetch(endpoint, { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderList(target, data.items || []);
          } catch (_) {
            setText(target, 'Feed unavailable.');
          }
        };
        async function loadMatched() { await load('/api/pipeline/matched', 'matched-opportunities'); }
        async function loadIngested() { await load('/api/pipeline/ingested', 'ingested-opportunities'); }
        async function loadGrantIntelligence() { await load('/api/grants/intelligence', 'grant-intelligence'); }
        async function loadGrantOpportunities() { await load('/api/grants/opportunities', 'grant-opportunities'); }
        async function loadDailyMission() { await load('/api/mission/today', 'daily-mission'); }
        async function loadPulse() { await load('/api/pulse/state', 'pulse-state'); }

        Promise.all([
          fetch('/api/system/state').then((response) => response.json()),
          fetch('/api/engine/last-refresh').then((response) => response.json()),
          fetch('/api/scraper/last-run').then((response) => response.json()),
          fetch('/api/matcher/last-run').then((response) => response.json()),
        ]).then(([system, refresh, scraper, matcher]) => {
          setText('status-strip', 'System: ' + (system.status || 'Unknown') + ' • Refresh: ' + (refresh.last_refresh || 'Unknown') + ' • Scraper: ' + (scraper.last_run || 'Unknown') + ' • Matcher: ' + (matcher.last_run || 'Unknown'));
          setIndicator('scraper-indicator', scraper.status === 'Ready');
          setIndicator('matcher-indicator', matcher.status === 'Ready');
          setIndicator('engine-indicator', refresh.pipeline_status === 'Ready');
          setIndicator('cluster-indicator', (system.cluster_nodes || []).some((node) => node.status === 'Active'));
          setText('cluster-banner', (system.cluster_nodes || []).map((node) => node.name + ' — ' + node.role + ': ' + node.status).join(' • '));
        }).catch(() => setText('status-strip', 'System status unavailable.'));

        Promise.all([loadMatched(), loadIngested(), loadGrantIntelligence(), loadGrantOpportunities(), loadDailyMission(), loadPulse()]);
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Primary Dashboard', content }));
});

app.get('/primary-dashboard-legacy', (req, res) => {
  const content = `
    <div class="dashboard-shell">
      <section class="page-hero">
        <p class="page-kicker">JE ROCKER Intelligence Layer</p>
        <h1 class="page-hero-title">Primary Dashboard</h1>
        <p class="page-hero-subtitle">Opportunity intelligence, competitive context, and capture execution in one operating surface.</p>
      </section>

      <section class="page-cluster">
        <div class="page-cluster-item">📡 <strong>signal_surface</strong>: Primary + Review feeds live</div>
        <div class="page-cluster-item">🧠 <strong>intel_mode</strong>: Human-first match interpretation</div>
        <div class="page-cluster-item">🛰️ <strong>competitive_context</strong>: Incumbent and vendor pattern aware</div>
        <div class="page-cluster-item">📬 <strong>submission_workflow</strong>: Pursuit tracking enabled</div>
      </section>

      <div class="cover-divider-band" aria-hidden="true"></div>

      <div class="grid grid-3">
        <section class="polish-panel polish-panel-expanded" id="primary-panel-competitive">
          <button class="polish-panel-header" type="button">
            <span class="polish-panel-icon">🧩</span>
            <span>Competitive Landscape Panel</span>
            <span class="polish-panel-module">Market Pressure Module</span>
          </button>
          <div class="polish-panel-body pd-intel-panel" data-primary-key="competitive">
            <div class="pd-intel-status" id="pd-status-competitive">Loading summary...</div>
            <div class="pd-intel-summary" id="pd-summary-competitive"></div>
            <button class="pd-intel-load-button" id="pd-load-competitive" type="button">Load Intelligence</button>
            <div class="pd-intel-loading" id="pd-loading-competitive" hidden>Loading deeper intelligence...</div>
            <div class="pd-intel-error" id="pd-error-competitive" hidden></div>
            <div class="pd-intel-deep" id="pd-deep-competitive" hidden></div>
            <div class="polish-panel-extra">Use this surface to judge vendor density, incumbent gravity, and whether the pursuit is likely open or entrenched.</div>
          </div>
        </section>

        <section class="polish-panel" id="primary-panel-agency">
          <button class="polish-panel-header" type="button">
            <span class="polish-panel-icon">🏢</span>
            <span>Agency Behavior Panel</span>
            <span class="polish-panel-module">Buying Motion Module</span>
          </button>
          <div class="polish-panel-body pd-intel-panel" data-primary-key="agency">
            <div class="pd-intel-status" id="pd-status-agency">Loading summary...</div>
            <div class="pd-intel-summary" id="pd-summary-agency"></div>
            <button class="pd-intel-load-button" id="pd-load-agency" type="button">Load Intelligence</button>
            <div class="pd-intel-loading" id="pd-loading-agency" hidden>Loading deeper intelligence...</div>
            <div class="pd-intel-error" id="pd-error-agency" hidden></div>
            <div class="pd-intel-deep" id="pd-deep-agency" hidden></div>
            <div class="polish-panel-extra" hidden>Interpret agency cadence, contracting habits, and lighter-weight entry points to improve timing and outreach posture.</div>
          </div>
        </section>

        <section class="polish-panel" id="primary-panel-vendor">
          <button class="polish-panel-header" type="button">
            <span class="polish-panel-icon">📚</span>
            <span>Vendor History Panel</span>
            <span class="polish-panel-module">Past Performance Module</span>
          </button>
          <div class="polish-panel-body pd-intel-panel" data-primary-key="vendor">
            <div class="pd-intel-status" id="pd-status-vendor">Loading summary...</div>
            <div class="pd-intel-summary" id="pd-summary-vendor"></div>
            <button class="pd-intel-load-button" id="pd-load-vendor" type="button">Load Intelligence</button>
            <div class="pd-intel-loading" id="pd-loading-vendor" hidden>Loading deeper intelligence...</div>
            <div class="pd-intel-error" id="pd-error-vendor" hidden></div>
            <div class="pd-intel-deep" id="pd-deep-vendor" hidden></div>
            <div class="polish-panel-extra" hidden>Read this module to understand whether a vendor is sticky with an agency or merely present in adjacent procurement lanes.</div>
          </div>
        </section>
      </div>

      <div class="grid grid-2" style="margin-top:12px;">
        <section class="polish-panel" id="primary-panel-capture">
          <button class="polish-panel-header" type="button">
            <span class="polish-panel-icon">📝</span>
            <span>Capture Plan Generator Panel</span>
            <span class="polish-panel-module">Action Design Module</span>
          </button>
          <div class="polish-panel-body pd-intel-panel" data-primary-key="capture">
            <div class="pd-intel-status" id="pd-status-capture">Loading summary...</div>
            <div class="pd-intel-summary" id="pd-summary-capture"></div>
            <button class="pd-intel-load-button" id="pd-load-capture" type="button">Load Intelligence</button>
            <div class="pd-intel-loading" id="pd-loading-capture" hidden>Loading deeper intelligence...</div>
            <div class="pd-intel-error" id="pd-error-capture" hidden></div>
            <div class="pd-intel-deep" id="pd-deep-capture" hidden></div>
            <div class="polish-panel-extra" hidden>This section is where opportunity facts should collapse into a usable pursuit stance with immediate next actions.</div>
          </div>
        </section>

        <section class="polish-panel" id="primary-panel-submission">
          <button class="polish-panel-header" type="button">
            <span class="polish-panel-icon">📬</span>
            <span>Submission Tracker Panel</span>
            <span class="polish-panel-module">Execution Module</span>
          </button>
          <div class="polish-panel-body pd-intel-panel" data-primary-key="submission">
            <div class="pd-intel-status" id="pd-status-submission">Loading summary...</div>
            <div class="pd-intel-summary" id="pd-summary-submission"></div>
            <button class="pd-intel-load-button" id="pd-load-submission" type="button">Load Intelligence</button>
            <div class="pd-intel-loading" id="pd-loading-submission" hidden>Loading deeper intelligence...</div>
            <div class="pd-intel-error" id="pd-error-submission" hidden></div>
            <div class="pd-intel-deep" id="pd-deep-submission" hidden></div>
            <div class="polish-panel-extra" hidden>Keep the execution loop disciplined by tying deadlines, status, and follow-up tasks into one visible control point.</div>
          </div>
        </section>
      </div>

      <div class="cover-divider-band" aria-hidden="true"></div>

      <section class="polish-card polish-card-embed">
        <div class="polish-card-headerline">
          <h3>Primary Dashboard</h3>
          <span>Existing alpha dashboard preserved exactly as-is (loaded on demand)</span>
        </div>
        <div class="alpha-embed" id="alphaEmbedHost">
          <div style="padding:24px;display:grid;gap:12px;align-content:center;justify-items:start;min-height:240px;">
            <p style="margin:0;color:var(--text-dim);max-width:66ch;">Load the full alpha surface only when needed. This keeps page transitions fast while preserving the original dashboard.</p>
            <button type="button" id="loadAlphaDashboardBtn" class="cover-button" style="min-width:220px;">Load Primary Feed</button>
          </div>
        </div>
      </section>
    </div>
    <script>
      (() => {
        const panels = Array.from(document.querySelectorAll('.polish-panel'));
        const attachAlphaDashboard = () => {
          const host = document.getElementById('alphaEmbedHost');
          if (!host || host.dataset.loaded === '1') return;
          const frame = document.createElement('iframe');
          frame.src = '/alpha_dashboard.html';
          frame.title = 'Primary Dashboard';
          frame.loading = 'lazy';
          host.innerHTML = '';
          host.appendChild(frame);
          host.dataset.loaded = '1';
        };
        const loadAlphaBtn = document.getElementById('loadAlphaDashboardBtn');
        if (loadAlphaBtn) {
          loadAlphaBtn.addEventListener('click', attachAlphaDashboard);
        }
        const panelConfig = {
          competitive: {
            panelId: 'primary-panel-competitive',
            summaryEndpoint: '/api/primary/competitive-summary',
            intelEndpoint: '/api/primary/competitive-intel',
          },
          agency: {
            panelId: 'primary-panel-agency',
            summaryEndpoint: '/api/primary/agency-summary',
            intelEndpoint: '/api/primary/agency-intel',
          },
          vendor: {
            panelId: 'primary-panel-vendor',
            summaryEndpoint: '/api/primary/vendor-summary',
            intelEndpoint: '/api/primary/vendor-intel',
          },
          capture: {
            panelId: 'primary-panel-capture',
            summaryEndpoint: '/api/primary/capture-summary',
            intelEndpoint: '/api/primary/capture-intel',
          },
          submission: {
            panelId: 'primary-panel-submission',
            summaryEndpoint: '/api/primary/submission-summary',
            intelEndpoint: '/api/primary/submission-intel',
          },
        };

        const panelState = Object.fromEntries(
          Object.keys(panelConfig).map((key) => [key, {
            summaryLoaded: false,
            deepLoaded: false,
            loadingSummary: false,
            loadingDeep: false,
            deepController: null,
          }])
        );

        const signalIcon = (signal) => {
          if (signal === 'up') return '▲';
          if (signal === 'alert') return '●';
          return '■';
        };

        const setPanelText = (id, value) => {
          const el = document.getElementById(id);
          if (el) el.textContent = value;
        };

        const renderRows = (rows = []) => {
          return rows.map((row) => {
            const label = String(row.label || 'metric');
            const value = String(row.value || 'N/A');
            const icon = signalIcon(row.signal);
            return '<div class="kv"><span>' + label + '</span><span><span class="pd-signal">' + icon + '</span> ' + value + '</span></div>';
          }).join('');
        };

        const renderIntelGroups = (intel = {}) => {
          return Object.entries(intel).map(([group, rows]) => {
            const title = group.replaceAll('_', ' ');
            const body = Array.isArray(rows) ? rows.map((row) => '<div class="kv"><span>' + String(row.label || 'item') + '</span><span>' + String(row.value || 'N/A') + '</span></div>').join('') : '<div class="kv"><span>info</span><span>N/A</span></div>';
            return '<div class="pd-intel-group"><div class="pd-intel-group-title">' + title + '</div>' + body + '</div>';
          }).join('');
        };

        const setLoading = (key, value) => {
          const loadingEl = document.getElementById('pd-loading-' + key);
          const button = document.getElementById('pd-load-' + key);
          if (loadingEl) loadingEl.hidden = !value;
          if (button) button.disabled = value;
        };

        async function loadSummary(key) {
          const cfg = panelConfig[key];
          const state = panelState[key];
          if (!cfg || state.loadingSummary || state.summaryLoaded) return;

          state.loadingSummary = true;
          setPanelText('pd-status-' + key, 'Loading summary...');

          try {
            const res = await fetch(cfg.summaryEndpoint, { cache: 'no-store' });
            if (!res.ok) throw new Error('summary failed');
            const payload = await res.json();
            const summaryEl = document.getElementById('pd-summary-' + key);
            if (summaryEl) {
              summaryEl.innerHTML = renderRows(payload.summary || []);
            }
            const statusText = payload.status === 'summary_loaded' ? 'Summary loaded' : 'Summary available';
            setPanelText('pd-status-' + key, statusText);
            state.summaryLoaded = true;
          } catch (_error) {
            setPanelText('pd-status-' + key, 'Unable to load summary');
          } finally {
            state.loadingSummary = false;
          }
        }

        async function loadDeepIntel(key, reason = 'manual') {
          const cfg = panelConfig[key];
          const state = panelState[key];
          if (!cfg || state.loadingDeep) return;

          if (state.deepController) {
            state.deepController.abort();
          }

          const controller = new AbortController();
          state.deepController = controller;
          state.loadingDeep = true;
          setLoading(key, true);

          const errorEl = document.getElementById('pd-error-' + key);
          const deepEl = document.getElementById('pd-deep-' + key);
          if (errorEl) {
            errorEl.hidden = true;
            errorEl.textContent = '';
          }
          if (deepEl) {
            deepEl.hidden = false;
            deepEl.innerHTML = '<div class="pd-intel-loading">Loading deeper intelligence...</div>';
          }
          setPanelText('pd-status-' + key, 'Loading deeper intelligence...');

          const focusParams = key === 'capture' && reason === 'expand'
            ? '?opportunity_id='
            : '';

          try {
            const res = await fetch(cfg.intelEndpoint + focusParams, {
              signal: controller.signal,
              cache: 'no-store',
            });
            if (!res.ok) throw new Error('intel failed');
            const payload = await res.json();

            if (deepEl) {
              deepEl.hidden = false;
              deepEl.innerHTML = renderIntelGroups(payload.intel || {});
            }

            if (payload.status === 'summary_only') {
              setPanelText('pd-status-' + key, 'Summary loaded');
            } else {
              setPanelText('pd-status-' + key, 'Intelligence ready');
              state.deepLoaded = true;
            }
          } catch (error) {
            if (error && error.name === 'AbortError') return;
            if (errorEl) {
              errorEl.hidden = false;
              errorEl.textContent = 'Unable to load intelligence';
            }
            setPanelText('pd-status-' + key, 'Unable to load intelligence');
          } finally {
            if (state.deepController === controller) {
              state.loadingDeep = false;
              state.deepController = null;
              setLoading(key, false);
            }
          }
        }

        Object.keys(panelConfig).forEach((key) => {
          loadSummary(key);
          const btn = document.getElementById('pd-load-' + key);
          if (btn) {
            btn.addEventListener('click', () => loadDeepIntel(key, 'button'));
          }
        });

        const panelKeyById = Object.fromEntries(Object.entries(panelConfig).map(([key, cfg]) => [cfg.panelId, key]));

        panels.forEach((panel) => {
          const header = panel.querySelector('.polish-panel-header');
          header.addEventListener('click', () => {
            const alreadyOpen = panel.classList.contains('polish-panel-expanded');
            panels.forEach((candidate) => {
              candidate.classList.remove('polish-panel-expanded');
              const extra = candidate.querySelector('.polish-panel-extra');
              if (extra) extra.hidden = true;
            });

            if (!alreadyOpen) {
              panel.classList.add('polish-panel-expanded');
              const extra = panel.querySelector('.polish-panel-extra');
              if (extra) extra.hidden = false;

              const key = panelKeyById[panel.id];
              if (key && !panelState[key].deepLoaded) {
                loadDeepIntel(key, 'expand');
              }
            }
          });
        });
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Primary Dashboard', content }));
});

app.get('/client-dashboard', (req, res) => {
  const clientId = Number.parseInt(String(req.query.client_id || ''), 10);
  const activeClientId = Number.isFinite(clientId) && clientId > 0 ? clientId : null;
  const content = `
    <div id="status-strip" class="client-status-strip" aria-live="polite">Loading client dashboard status...</div>

    <main class="client-blueprint" data-client-id="${activeClientId || ''}">
      <div class="dashboard-container">
        <section class="panel panel-left">
          <h2>Client Profile</h2>
          <div id="client-info">${activeClientId ? 'Loading client profile...' : 'Open this dashboard with a client_id to activate client intelligence.'}</div>
        </section>

        <section class="panel panel-middle">
          <h2>Intelligence Feed</h2>
          <div id="intelligence-feed" class="feed">${activeClientId ? 'Loading intelligence feed...' : 'Client intelligence will appear after a client context is selected.'}</div>
        </section>

        <section class="panel panel-right">
          <h2>Actions</h2>
          <button type="button" onclick="triggerScraper()">Run Scraper</button>
          <button type="button" onclick="triggerMatcher()">Run Matcher</button>
          <button type="button" onclick="refreshEngine()">Refresh Engine</button>
          <button type="button" onclick="syncCluster()">Sync Cluster</button>
          <p id="client-action-status" class="client-action-status">Execution controls are inactive on this wiring node.</p>
        </section>
      </div>

      <div class="indicators-container" aria-label="Engine indicators">
        <div><div id="scraper-indicator" class="indicator"></div><span>Scraper</span></div>
        <div><div id="matcher-indicator" class="indicator"></div><span>Matcher</span></div>
        <div><div id="engine-indicator" class="indicator"></div><span>Engine</span></div>
        <div><div id="cluster-indicator" class="indicator"></div><span>Cluster</span></div>
      </div>

      <div id="cluster-banner" aria-live="polite">Loading cluster roles...</div>
    </main>

    <footer class="client-blueprint-footer">JE ROCKER LC • GovTech Intelligence Platform</footer>

    <script>
      (() => {
        const clientId = document.querySelector('.client-blueprint').dataset.clientId;
        const setText = (id, text) => {
          const element = document.getElementById(id);
          if (element) element.textContent = text;
        };
        const setIndicator = (id, active) => {
          const element = document.getElementById(id);
          if (element) element.classList.toggle('indicator-active', active);
        };
        const renderClient = (client) => {
          const fields = [
            ['Name', client.client_name], ['UEI', client.uei], ['NAICS', client.naics],
            ['Keywords', client.keywords], ['Preferred agencies', client.preferred_agencies],
          ];
          document.getElementById('client-info').innerHTML = fields.map(([key, value]) =>
            '<div class="client-blueprint-kv"><span>' + key + '</span><strong>' + (value || 'N/A') + '</strong></div>'
          ).join('');
        };
        const renderFeed = (payload) => {
          const opportunities = payload.opportunities || [];
          document.getElementById('intelligence-feed').innerHTML = opportunities.length
            ? opportunities.map((item) => '<article class="client-feed-item"><strong>' + (item.title || 'Untitled opportunity') + '</strong><span>' + (item.agency || 'Agency unavailable') + ' • Relevance ' + (item.relevance_score || 'N/A') + '%</span></article>').join('')
            : 'No client-fit opportunities are available.';
        };
        const commandUnavailable = (name) => {
          setText('client-action-status', name + ' is not enabled on MacMiller. Macklemore remains the driver node.');
        };
        window.triggerScraper = () => commandUnavailable('Run Scraper');
        window.triggerMatcher = () => commandUnavailable('Run Matcher');
        window.refreshEngine = () => commandUnavailable('Refresh Engine');
        window.syncCluster = () => commandUnavailable('Sync Cluster');

        Promise.all([
          fetch('/api/system/state').then((response) => response.json()),
          fetch('/api/engine/last-refresh').then((response) => response.json()),
          fetch('/api/scraper/last-run').then((response) => response.json()),
          fetch('/api/matcher/last-run').then((response) => response.json()),
        ]).then(([system, refresh, scraper, matcher]) => {
          setText('status-strip', 'System: ' + (system.status || 'Unknown') + ' • Refresh: ' + (refresh.last_refresh || 'Unknown') + ' • Scraper: ' + (scraper.last_run || 'Unknown') + ' • Matcher: ' + (matcher.last_run || 'Unknown'));
          setIndicator('scraper-indicator', scraper.status === 'Ready');
          setIndicator('matcher-indicator', matcher.status === 'Ready');
          setIndicator('engine-indicator', refresh.pipeline_status === 'Ready');
          setIndicator('cluster-indicator', (system.cluster_nodes || []).some((node) => node.status === 'Active'));
          setText('cluster-banner', (system.cluster_nodes || []).map((node) => node.name + ' — ' + node.role + ': ' + node.status).join(' • '));
        }).catch(() => setText('status-strip', 'System status unavailable.'));

        if (!clientId) return;
        fetch('/api/client/' + encodeURIComponent(clientId), { cache: 'no-store' })
          .then((response) => response.ok ? response.json() : Promise.reject())
          .then(renderClient)
          .catch(() => setText('client-info', 'Client profile unavailable.'));
        fetch('/api/client/intel/opportunities?client_id=' + encodeURIComponent(clientId) + '&view=deep', { cache: 'no-store' })
          .then((response) => response.ok ? response.json() : Promise.reject())
          .then(renderFeed)
          .catch(() => setText('intelligence-feed', 'Client intelligence feed unavailable.'));
      })();
    </script>
  `;
  res.send(htmlLayout({
    title: 'JE ROCKER LC - Client Dashboard',
    content,
    extraHead: '<link rel="stylesheet" href="/src/styles/client.css" />',
  }));
});

app.get('/client-dashboard-legacy', (req, res) => {
  const content = `
    <div class="dashboard-shell">
      <section class="page-hero">
        <p class="page-kicker">Client Intelligence Surface</p>
        <h1 class="page-hero-title">Client Dashboard</h1>
        <p class="page-hero-subtitle">Activate a client context to load weekly intelligence, opportunities, spend trends, and capture recommendations.</p>
      </section>

      <section class="client-search-bar">
        <input id="clientSearchInput" type="text" placeholder="Search client by name, UEI, DUNS, NAICS, or keyword" />
        <button id="clientSearchButton" type="button">Search Client</button>
      </section>
      <div id="clientSearchStatus" class="pd-intel-status">Waiting for client...</div>
      <div id="clientSearchResults" class="client-search-results"></div>

      <section class="page-cluster">
        <div class="page-cluster-item">🗓️ <strong>weekly_refresh</strong>: Monday intelligence cadence</div>
        <div class="page-cluster-item">📥 <strong>opportunity_flow</strong>: Client-fit opportunities prioritized</div>
        <div class="page-cluster-item">📈 <strong>spend_shift</strong>: Agency and vendor signals summarized</div>
        <div class="page-cluster-item">🎯 <strong>capture_readiness</strong>: Strategy recommendations staged</div>
      </section>

      <div class="cover-divider-band" aria-hidden="true"></div>

      <div class="grid grid-2">
        <section class="polish-panel polish-panel-expanded" id="client-panel-weekly">
          <button class="polish-panel-header" type="button">
            <span class="polish-panel-icon">🗞️</span>
            <span>Weekly Intelligence Report Panel</span>
            <span class="polish-panel-module">Briefing Module</span>
          </button>
          <div class="polish-panel-body pd-intel-panel" data-client-key="weekly">
            <div class="pd-intel-status" id="cd-status-weekly">Waiting for client...</div>
            <div class="pd-intel-summary" id="cd-summary-weekly"></div>
            <button class="pd-intel-load-button" id="cd-load-weekly" type="button" disabled>Load Intelligence</button>
            <div class="pd-intel-loading" id="cd-loading-weekly" hidden>Loading deeper intelligence...</div>
            <div class="pd-intel-error" id="cd-error-weekly" hidden></div>
            <div class="pd-intel-deep" id="cd-deep-weekly" hidden></div>
            <div class="polish-panel-extra">This briefing layer should read like a Monday client pulse report: what changed, what matters, what should be acted on.</div>
          </div>
        </section>

        <section class="polish-panel" id="client-panel-feed">
          <button class="polish-panel-header" type="button">
            <span class="polish-panel-icon">📥</span>
            <span>Opportunity Feed Panel</span>
            <span class="polish-panel-module">Intake Module</span>
          </button>
          <div class="polish-panel-body pd-intel-panel" data-client-key="feed">
            <div class="pd-intel-status" id="cd-status-feed">Waiting for client...</div>
            <div class="pd-intel-summary" id="cd-summary-feed"></div>
            <button class="pd-intel-load-button" id="cd-load-feed" type="button" disabled>Load Intelligence</button>
            <div class="pd-intel-loading" id="cd-loading-feed" hidden>Loading deeper intelligence...</div>
            <div class="pd-intel-error" id="cd-error-feed" hidden></div>
            <div class="pd-intel-deep" id="cd-deep-feed" hidden></div>
            <div class="polish-panel-extra" hidden>Use this intake view to screen for urgency, alignment, and avoidable risk before recommending pursuit.</div>
          </div>
        </section>

        <section class="polish-panel" id="client-panel-matches">
          <button class="polish-panel-header" type="button">
            <span class="polish-panel-icon">🎯</span>
            <span>Matches Panel</span>
            <span class="polish-panel-module">Fit Module</span>
          </button>
          <div class="polish-panel-body pd-intel-panel" data-client-key="matches">
            <div class="pd-intel-status" id="cd-status-matches">Waiting for client...</div>
            <div class="pd-intel-summary" id="cd-summary-matches"></div>
            <button class="pd-intel-load-button" id="cd-load-matches" type="button" disabled>Load Intelligence</button>
            <div class="pd-intel-loading" id="cd-loading-matches" hidden>Loading deeper intelligence...</div>
            <div class="pd-intel-error" id="cd-error-matches" hidden></div>
            <div class="pd-intel-deep" id="cd-deep-matches" hidden></div>
            <div class="polish-panel-extra" hidden>This module should help explain not just that a match exists, but why the recommendation deserves attention.</div>
          </div>
        </section>

        <section class="polish-panel" id="client-panel-spend">
          <button class="polish-panel-header" type="button">
            <span class="polish-panel-icon">📈</span>
            <span>Spend Trends Panel</span>
            <span class="polish-panel-module">Trend Module</span>
          </button>
          <div class="polish-panel-body pd-intel-panel" data-client-key="spend">
            <div class="pd-intel-status" id="cd-status-spend">Waiting for client...</div>
            <div class="pd-intel-summary" id="cd-summary-spend"></div>
            <button class="pd-intel-load-button" id="cd-load-spend" type="button" disabled>Load Intelligence</button>
            <div class="pd-intel-loading" id="cd-loading-spend" hidden>Loading deeper intelligence...</div>
            <div class="pd-intel-error" id="cd-error-spend" hidden></div>
            <div class="pd-intel-deep" id="cd-deep-spend" hidden></div>
            <div class="polish-panel-extra" hidden>Focus here on directional movement and whether funding or obligation patterns support a future pursuit narrative.</div>
          </div>
        </section>

        <section class="polish-panel" id="client-panel-vendor">
          <button class="polish-panel-header" type="button">
            <span class="polish-panel-icon">👤</span>
            <span>Vendor Profiles Panel</span>
            <span class="polish-panel-module">Competitor Module</span>
          </button>
          <div class="polish-panel-body pd-intel-panel" data-client-key="vendor">
            <div class="pd-intel-status" id="cd-status-vendor">Waiting for client...</div>
            <div class="pd-intel-summary" id="cd-summary-vendor"></div>
            <button class="pd-intel-load-button" id="cd-load-vendor" type="button" disabled>Load Intelligence</button>
            <div class="pd-intel-loading" id="cd-loading-vendor" hidden>Loading deeper intelligence...</div>
            <div class="pd-intel-error" id="cd-error-vendor" hidden></div>
            <div class="pd-intel-deep" id="cd-deep-vendor" hidden></div>
            <div class="polish-panel-extra" hidden>Profile likely competitors by incumbency, modification behavior, and spending footprint before briefing the client.</div>
          </div>
        </section>

        <section class="polish-panel" id="client-panel-capture">
          <button class="polish-panel-header" type="button">
            <span class="polish-panel-icon">🧠</span>
            <span>Capture Plan Recommendations Panel</span>
            <span class="polish-panel-module">Recommendation Module</span>
          </button>
          <div class="polish-panel-body pd-intel-panel" data-client-key="capture">
            <div class="pd-intel-status" id="cd-status-capture">Waiting for client...</div>
            <div class="pd-intel-summary" id="cd-summary-capture"></div>
            <button class="pd-intel-load-button" id="cd-load-capture" type="button" disabled>Load Intelligence</button>
            <div class="pd-intel-loading" id="cd-loading-capture" hidden>Loading deeper intelligence...</div>
            <div class="pd-intel-error" id="cd-error-capture" hidden></div>
            <div class="pd-intel-deep" id="cd-deep-capture" hidden></div>
            <div class="polish-panel-extra" hidden>Turn intelligence into decision-ready recommendations by highlighting which opportunities deserve immediate client attention.</div>
          </div>
        </section>
      </div>

      <div class="cover-divider-band" aria-hidden="true"></div>

      <section class="client-dashboard-container">
        <article class="client-profile-panel">
          <div class="client-panel-header">Client Profile</div>
          <div class="client-panel-body" id="clientProfilePanel">Waiting for client...</div>
        </article>
        <article class="client-opportunities-panel">
          <div class="client-panel-header">Top 10 Opportunities</div>
          <div class="client-panel-body" id="clientOpportunitiesPanel">Waiting for client...</div>
        </article>
        <article class="client-opportunity-intel-panel">
          <div class="client-panel-header">Opportunity Intel</div>
          <div class="client-panel-body" id="clientOpportunityIntelPanel">Waiting for opportunity selection...</div>
        </article>
      </section>
    </div>
    <script>
      (() => {
        let activeClient = null;
        let clientProfile = null;
        let clientOpportunities = [];
        let clientOpportunityIntel = null;

        let searchTerm = '';
        let searchController = null;
        let opportunityIntelController = null;

        const searchInput = document.getElementById('clientSearchInput');
        const searchButton = document.getElementById('clientSearchButton');
        const searchStatus = document.getElementById('clientSearchStatus');
        const searchResults = document.getElementById('clientSearchResults');

        const profilePanel = document.getElementById('clientProfilePanel');
        const opportunitiesPanel = document.getElementById('clientOpportunitiesPanel');
        const opportunityIntelPanel = document.getElementById('clientOpportunityIntelPanel');

        const panels = Array.from(document.querySelectorAll('.polish-panel'));
        const panelConfig = {
          weekly: {
            panelId: 'client-panel-weekly',
            endpoint: '/api/client/intel/weekly',
          },
          feed: {
            panelId: 'client-panel-feed',
            endpoint: '/api/client/intel/opportunities',
          },
          matches: {
            panelId: 'client-panel-matches',
            endpoint: '/api/client/intel/matches',
          },
          spend: {
            panelId: 'client-panel-spend',
            endpoint: '/api/client/intel/spend',
          },
          vendor: {
            panelId: 'client-panel-vendor',
            endpoint: '/api/client/intel/vendors',
          },
          capture: {
            panelId: 'client-panel-capture',
            endpoint: '/api/client/intel/capture',
          },
        };

        const panelState = Object.fromEntries(
          Object.keys(panelConfig).map((key) => [key, {
            summaryLoaded: false,
            deepLoaded: false,
            loadingSummary: false,
            loadingDeep: false,
            deepController: null,
          }])
        );

        const signalIcon = (signal) => {
          if (signal === 'up') return '▲';
          if (signal === 'alert') return '●';
          return '■';
        };

        const setPanelText = (id, value) => {
          const el = document.getElementById(id);
          if (el) el.textContent = value;
        };

        const renderRows = (rows = []) => {
          return rows.map((row) => {
            const label = String(row.label || 'metric');
            const value = String(row.value || 'N/A');
            const icon = signalIcon(row.signal);
            return '<div class="kv"><span>' + label + '</span><span><span class="pd-signal">' + icon + '</span> ' + value + '</span></div>';
          }).join('');
        };

        const renderIntelGroups = (intel = {}) => {
          return Object.entries(intel).map(([group, rows]) => {
            const title = group.replaceAll('_', ' ');
            const body = Array.isArray(rows)
              ? rows.map((row) => '<div class="kv"><span>' + String(row.label || 'item') + '</span><span>' + String(row.value || 'N/A') + '</span></div>').join('')
              : '<div class="kv"><span>info</span><span>N/A</span></div>';
            return '<div class="pd-intel-group"><div class="pd-intel-group-title">' + title + '</div>' + body + '</div>';
          }).join('');
        };

        const setLoading = (key, value) => {
          const loadingEl = document.getElementById('cd-loading-' + key);
          const button = document.getElementById('cd-load-' + key);
          if (loadingEl) loadingEl.hidden = !value;
          if (button) button.disabled = value || !activeClient;
        };

        const resetModuleVisuals = (key) => {
          const summaryEl = document.getElementById('cd-summary-' + key);
          const deepEl = document.getElementById('cd-deep-' + key);
          const errorEl = document.getElementById('cd-error-' + key);
          const button = document.getElementById('cd-load-' + key);

          if (summaryEl) summaryEl.innerHTML = '';
          if (deepEl) {
            deepEl.hidden = true;
            deepEl.innerHTML = '';
          }
          if (errorEl) {
            errorEl.hidden = true;
            errorEl.textContent = '';
          }
          if (button) button.disabled = !activeClient;
          setPanelText('cd-status-' + key, activeClient ? 'Loading summary...' : 'Waiting for client...');
        };

        const clientQuery = () => {
          if (!activeClient || !activeClient.client_id) return '';
          return '?client_id=' + encodeURIComponent(String(activeClient.client_id));
        };

        async function loadSummary(key) {
          const cfg = panelConfig[key];
          const state = panelState[key];
          if (!cfg || !activeClient || state.loadingSummary || state.summaryLoaded) return;

          state.loadingSummary = true;
          setPanelText('cd-status-' + key, 'Loading summary...');

          try {
            const res = await fetch(cfg.endpoint + clientQuery() + '&view=summary', { cache: 'no-store' });
            if (!res.ok) throw new Error('summary failed');
            const payload = await res.json();
            const summaryEl = document.getElementById('cd-summary-' + key);
            if (summaryEl) summaryEl.innerHTML = renderRows(payload.summary || []);
            setPanelText('cd-status-' + key, 'Summary loaded');
            state.summaryLoaded = true;
          } catch (_error) {
            setPanelText('cd-status-' + key, 'Unable to load summary');
          } finally {
            state.loadingSummary = false;
          }
        }

        async function loadDeepIntel(key, reason = 'manual') {
          const cfg = panelConfig[key];
          const state = panelState[key];
          if (!cfg || !activeClient || state.loadingDeep) return;

          if (state.deepController) {
            state.deepController.abort();
          }

          const controller = new AbortController();
          state.deepController = controller;
          state.loadingDeep = true;
          setLoading(key, true);

          const errorEl = document.getElementById('cd-error-' + key);
          const deepEl = document.getElementById('cd-deep-' + key);
          if (errorEl) {
            errorEl.hidden = true;
            errorEl.textContent = '';
          }
          if (deepEl) {
            deepEl.hidden = false;
            deepEl.innerHTML = '<div class="pd-intel-loading">Loading deeper intelligence...</div>';
          }
          setPanelText('cd-status-' + key, 'Loading deeper intelligence...');

          try {
            const res = await fetch(cfg.endpoint + clientQuery() + '&view=deep', {
              signal: controller.signal,
              cache: 'no-store',
            });
            if (!res.ok) throw new Error('intel failed');
            const payload = await res.json();

            if (deepEl) {
              deepEl.hidden = false;
              deepEl.innerHTML = renderIntelGroups(payload.deep || payload.intel || {});
            }

            if (payload.status === 'summary_only') {
              setPanelText('cd-status-' + key, 'Summary loaded');
            } else {
              setPanelText('cd-status-' + key, 'Intelligence ready');
              state.deepLoaded = true;
            }
          } catch (error) {
            if (error && error.name === 'AbortError') return;
            if (errorEl) {
              errorEl.hidden = false;
              errorEl.textContent = 'Unable to load intelligence';
            }
            setPanelText('cd-status-' + key, 'Unable to load intelligence');
          } finally {
            if (state.deepController === controller) {
              state.loadingDeep = false;
              state.deepController = null;
              setLoading(key, false);
            }
          }
        }

        Object.keys(panelConfig).forEach((key) => {
          resetModuleVisuals(key);
          const btn = document.getElementById('cd-load-' + key);
          if (btn) {
            btn.addEventListener('click', () => loadDeepIntel(key, 'button'));
          }
        });

        function renderClientProfile() {
          if (!clientProfile) {
            profilePanel.textContent = 'Waiting for client...';
            return;
          }
          profilePanel.innerHTML = [
            ['client_name', clientProfile.client_name],
            ['UEI', clientProfile.uei],
            ['DUNS', clientProfile.duns],
            ['NAICS', clientProfile.naics],
            ['keywords', clientProfile.keywords],
            ['preferred agencies', clientProfile.preferred_agencies],
            ['past performance', clientProfile.past_performance],
            ['notes', clientProfile.notes],
          ].map((row) => '<div class="kv"><span>' + row[0] + '</span><span>' + (row[1] || 'N/A') + '</span></div>').join('');
        }

        function renderOpportunities() {
          if (!activeClient) {
            opportunitiesPanel.textContent = 'Waiting for client...';
            return;
          }
          if (!clientOpportunities.length) {
            opportunitiesPanel.textContent = 'No opportunities loaded.';
            return;
          }
          opportunitiesPanel.innerHTML = clientOpportunities.map((row) => {
            const id = String(row.opportunity_id || row.title);
            return '<button type="button" class="client-opportunity-card" data-opp-id="' + id + '"><div><strong>' + row.title + '</strong></div><div class="intel-count">' + row.agency + ' • PSC ' + row.psc + '</div><div class="intel-count">Relevance ' + row.relevance_score + '% • Due ' + (row.due_date || 'N/A') + '</div><div class="intel-count">Risk: ' + row.risk_indicators + ' • Confidence: ' + row.match_confidence + '</div></button>';
          }).join('');

          const cards = Array.from(opportunitiesPanel.querySelectorAll('.client-opportunity-card'));
          cards.forEach((card) => {
            card.addEventListener('click', async () => {
              cards.forEach((c) => c.classList.remove('client-opportunity-card-active'));
              card.classList.add('client-opportunity-card-active');
              const oppId = card.getAttribute('data-opp-id');
              await loadOpportunityIntel(oppId);
            });
          });
        }

        function renderOpportunityIntel() {
          if (!activeClient) {
            opportunityIntelPanel.textContent = 'Waiting for opportunity selection...';
            return;
          }
          if (!clientOpportunityIntel) {
            opportunityIntelPanel.textContent = 'Click an opportunity to load intelligence.';
            return;
          }
          opportunityIntelPanel.innerHTML = Object.entries(clientOpportunityIntel).map(([key, value]) => {
            return '<div class="kv"><span>' + key.replaceAll('_', ' ') + '</span><span>' + String(value || 'N/A') + '</span></div>';
          }).join('');
        }

        async function loadOpportunityIntel(oppId) {
          if (!activeClient || !oppId) return;
          if (opportunityIntelController) {
            opportunityIntelController.abort();
          }
          const controller = new AbortController();
          opportunityIntelController = controller;
          opportunityIntelPanel.textContent = 'Loading opportunity intelligence...';

          try {
            const res = await fetch('/api/client/intel/opportunity/' + encodeURIComponent(oppId) + '?client_id=' + encodeURIComponent(String(activeClient.client_id)), {
              signal: controller.signal,
              cache: 'no-store',
            });
            if (!res.ok) throw new Error('Opportunity intel failed');
            const payload = await res.json();
            clientOpportunityIntel = payload.intel || null;
            renderOpportunityIntel();
          } catch (error) {
            if (error && error.name === 'AbortError') return;
            opportunityIntelPanel.textContent = 'Unable to load opportunity intelligence.';
          }
        }

        async function loadTopOpportunities() {
          if (!activeClient) return;
          opportunitiesPanel.textContent = 'Loading top opportunities...';
          try {
            const res = await fetch('/api/client/intel/opportunities?client_id=' + encodeURIComponent(String(activeClient.client_id)) + '&view=deep', { cache: 'no-store' });
            if (!res.ok) throw new Error('Top opportunities failed');
            const payload = await res.json();
            clientOpportunities = (payload.opportunities || []).slice(0, 10);
            renderOpportunities();
          } catch (_error) {
            opportunitiesPanel.textContent = 'Unable to load opportunities.';
          }
        }

        async function activateClientContext(clientLite) {
          try {
            const res = await fetch('/api/client/' + encodeURIComponent(String(clientLite.client_id)), { cache: 'no-store' });
            if (!res.ok) throw new Error('Client fetch failed');
            const clientRecord = await res.json();

            activeClient = clientRecord;
            clientProfile = clientRecord;
            clientOpportunities = [];
            clientOpportunityIntel = null;

            searchStatus.textContent = 'Active client: ' + (clientRecord.client_name || ('Client #' + clientRecord.client_id));
            searchResults.innerHTML = '';

            renderClientProfile();
            renderOpportunities();
            renderOpportunityIntel();

            Object.keys(panelConfig).forEach((key) => {
              panelState[key].summaryLoaded = false;
              panelState[key].deepLoaded = false;
              panelState[key].loadingSummary = false;
              panelState[key].loadingDeep = false;
              if (panelState[key].deepController) panelState[key].deepController.abort();
              panelState[key].deepController = null;
              resetModuleVisuals(key);
            });

            await Promise.all(Object.keys(panelConfig).map((key) => loadSummary(key)));
            await loadTopOpportunities();
          } catch (_error) {
            searchStatus.textContent = 'Unable to activate client context';
          }
        }

        function renderClientSelection(clients) {
          if (!clients.length) {
            searchResults.innerHTML = '<div class="pd-intel-error">No client found — create new client?</div>';
            return;
          }

          searchResults.innerHTML = clients.map((client) => {
            const name = client.client_name || ('Client #' + client.client_id);
            const meta = [client.uei || 'No UEI', client.naics || 'No NAICS'].join(' • ');
            return '<button type="button" class="client-opportunity-card" data-client-id="' + client.client_id + '"><div><strong>' + name + '</strong></div><div class="intel-count">' + meta + '</div></button>';
          }).join('');

          Array.from(searchResults.querySelectorAll('[data-client-id]')).forEach((button) => {
            button.addEventListener('click', () => {
              const id = Number(button.getAttribute('data-client-id'));
              const selected = clients.find((row) => Number(row.client_id) === id);
              if (selected) activateClientContext(selected);
            });
          });
        }

        async function runClientSearch() {
          searchTerm = String(searchInput.value || '').trim();

          if (searchTerm.length < 2) {
            searchStatus.textContent = 'Enter at least 2 characters';
            searchResults.innerHTML = '';
            return;
          }

          if (searchController) {
            searchController.abort();
          }
          const controller = new AbortController();
          searchController = controller;

          searchButton.disabled = true;
          searchStatus.textContent = 'Searching clients...';
          searchResults.innerHTML = '';

          try {
            const res = await fetch('/api/client/search?term=' + encodeURIComponent(searchTerm), {
              signal: controller.signal,
              cache: 'no-store',
            });
            if (!res.ok) throw new Error('Search failed');
            const payload = await res.json();
            const clients = payload.clients || [];

            if (!clients.length) {
              searchStatus.textContent = 'No client found — create new client?';
              renderClientSelection([]);
              return;
            }

            if (clients.length === 1) {
              searchStatus.textContent = 'Client found. Activating context...';
              await activateClientContext(clients[0]);
              return;
            }

            searchStatus.textContent = 'Multiple clients found. Select one to activate context.';
            renderClientSelection(clients);
          } catch (error) {
            if (error && error.name === 'AbortError') return;
            searchStatus.textContent = 'Client search unavailable';
            searchResults.innerHTML = '<div class="pd-intel-error">Unable to complete client search.</div>';
          } finally {
            searchButton.disabled = false;
          }
        }

        searchButton.addEventListener('click', runClientSearch);
        searchInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            runClientSearch();
          }
        });

        renderClientProfile();
        renderOpportunities();
        renderOpportunityIntel();

        const panelKeyById = Object.fromEntries(Object.entries(panelConfig).map(([key, cfg]) => [cfg.panelId, key]));

        panels.forEach((panel) => {
          const header = panel.querySelector('.polish-panel-header');
          header.addEventListener('click', () => {
            const alreadyOpen = panel.classList.contains('polish-panel-expanded');
            panels.forEach((candidate) => {
              candidate.classList.remove('polish-panel-expanded');
              const extra = candidate.querySelector('.polish-panel-extra');
              if (extra) extra.hidden = true;
            });
            if (!alreadyOpen) {
              panel.classList.add('polish-panel-expanded');
              const extra = panel.querySelector('.polish-panel-extra');
              if (extra) extra.hidden = false;

              const key = panelKeyById[panel.id];
              if (key) {
                setPanelText('cd-status-' + key, panelState[key].deepLoaded ? 'Intelligence ready' : 'Summary loaded');
              }
            }
          });
        });
      })();
    </script>
  `;
  res.send(htmlLayout({
    title: 'JE ROCKER LC - Client Dashboard',
    content,
    extraHead: '<link rel="stylesheet" href="/src/styles/client.css" />',
  }));
});

app.listen(PORT, () => {
  console.log(`Dashboard API running on http://localhost:${PORT}`);
});
