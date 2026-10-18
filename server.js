const express = require('express');
const { execFile } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { createClient, clientEvents } = require('./src/utils/db');
const { listGrants, getGrantDetail, getGrantSignals } = require('./src/grants/grants_service');
const { loadLiveGrants, prioritizeGrants } = require('./engine/grants');
const { loadLiveOpportunities, loadStateOpportunities, matchesQuery, summarizeOpportunities } = require('./engine/opportunities');
const { getClientIngestionSummary, loadClient, runClientIngestion, scoreItem } = require('./engine/clientIngestion');
const { startGneScheduler } = require('./server/index');
const { registerHeadhunterRoutes, headhunterPanelHtml } = require('./server/headhunter');
const { registerGovtechCommercialRoutes } = require('./server/govtech/commercial');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const LIVE_INDEX_OPPORTUNITIES = Number(process.env.LIVE_INDEX_OPPORTUNITIES || 17583);

const fpds = new sqlite3.Database('./db/fpds.db');
const opp = new sqlite3.Database('./db/opportunities.db');
const matches = new sqlite3.Database('./db/matches.db');
const clientDb = new sqlite3.Database('./client.db');
const PIPELINE_ROOT = process.env.JE_ROCKER_PIPELINE_ROOT || '/Volumes/Data Drive/Govtech/JE ROCKER';
const FORECAST_DB_PATH = path.join(__dirname, 'data', 'forecast.db');
const PYTHON_BIN = process.env.PYTHON_BIN || `${PIPELINE_ROOT}/.venv/bin/python`;

function loadDSM() {
  const base = path.join(__dirname, 'dsm');
  return {
    naics: JSON.parse(fs.readFileSync(path.join(base, 'naics.json'), 'utf8')),
    psc: JSON.parse(fs.readFileSync(path.join(base, 'psc.json'), 'utf8')),
    agency: JSON.parse(fs.readFileSync(path.join(base, 'agency.json'), 'utf8')),
    modernization: JSON.parse(fs.readFileSync(path.join(base, 'modernization.json'), 'utf8')),
    grants: JSON.parse(fs.readFileSync(path.join(base, 'grants.json'), 'utf8')),
    capability: JSON.parse(fs.readFileSync(path.join(base, 'capability.json'), 'utf8')),
  };
}

const DSM = loadDSM();
const driftLogPath = path.join(__dirname, 'logs', 'drift.log');

fs.mkdirSync(path.dirname(driftLogPath), { recursive: true });

function logDriftEvents(events) {
  if (!events || events.length === 0) return;

  const lines = events.map((event) => JSON.stringify({
    field: event.field,
    original: event.original,
    corrected: event.corrected,
    reason: event.reason,
    timestamp: event.timestamp,
    node: process.env.NODE_NAME || 'unknown',
    role: process.env.NODE_ROLE || 'unknown',
  }));

  fs.appendFileSync(driftLogPath, `${lines.join('\n')}\n`);
}

function applyDriftSuppression(raw = {}) {
  const result = {
    stableNaics: raw.naics || null,
    stablePsc: raw.psc || null,
    stableAgency: raw.agency || null,
    stableModernization: raw.modernization || null,
    stableGrantCategory: raw.grantCategory || null,
    stableCapabilityZone: raw.capabilityZone || null,
    driftEvents: [],
  };

  function suppress(field, value, dsmMap) {
    if (!value) return value;

    if (dsmMap.canonical.includes(value)) return value;

    if (dsmMap.synonyms[value]) {
      const corrected = dsmMap.synonyms[value];
      result.driftEvents.push({ field, original: value, corrected, reason: 'synonym', timestamp: Date.now() });
      return corrected;
    }

    for (const pattern in dsmMap.driftPatterns) {
      if (value.includes(pattern)) {
        const corrected = dsmMap.driftPatterns[pattern];
        result.driftEvents.push({ field, original: value, corrected, reason: 'pattern', timestamp: Date.now() });
        return corrected;
      }
    }

    for (const rule in dsmMap.suppressionRules) {
      if (value === rule) {
        const corrected = dsmMap.suppressionRules[rule];
        result.driftEvents.push({ field, original: value, corrected, reason: 'rule', timestamp: Date.now() });
        return corrected;
      }
    }

    return value;
  }

  result.stableNaics = suppress('naics', result.stableNaics, DSM.naics);
  result.stablePsc = suppress('psc', result.stablePsc, DSM.psc);
  result.stableAgency = suppress('agency', result.stableAgency, DSM.agency);
  result.stableModernization = suppress('modernization', result.stableModernization, DSM.modernization);
  result.stableGrantCategory = suppress('grantCategory', result.stableGrantCategory, DSM.grants);
  result.stableCapabilityZone = suppress('capabilityZone', result.stableCapabilityZone, DSM.capability);

  return result;
}

function stabilizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const stable = applyDriftSuppression({
      ...item,
      naics: item.naics ?? item.naics_code,
      psc: item.psc ?? item.psc_code,
      grantCategory: item.grantCategory ?? item.grant_category,
      capabilityZone: item.capabilityZone ?? item.capability_zone,
    });
    logDriftEvents(stable.driftEvents);
    return {
      ...item,
      naics: stable.stableNaics,
      psc: stable.stablePsc,
      agency: stable.stableAgency,
      modernization: stable.stableModernization,
      grantCategory: stable.stableGrantCategory,
      capabilityZone: stable.stableCapabilityZone,
      stableNaics: stable.stableNaics,
      stablePsc: stable.stablePsc,
      stableAgency: stable.stableAgency,
      stableModernization: stable.stableModernization,
      stableGrantCategory: stable.stableGrantCategory,
      stableCapabilityZone: stable.stableCapabilityZone,
      driftEvents: stable.driftEvents,
    };
  });
}

function stabilizeSearchRows(rows) {
  if (Array.isArray(rows)) return stabilizeItems(rows);
  if (rows && typeof rows === 'object') {
    return Object.fromEntries(Object.entries(rows).map(([key, value]) => [
      key,
      Array.isArray(value) ? stabilizeItems(value) : value,
    ]));
  }
  return rows;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

clientEvents.on('onClientCreated', (client) => {
  console.info(`[client] created pending client ${client.id}`);
  runClientIngestion(client.id)
    .then(() => console.info(`[client] live ingestion completed for ${client.id}`))
    .catch((error) => console.error(`[client] live ingestion failed for ${client.id}: ${error.message}`));
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
  clientDb.run('ALTER TABLE clients ADD COLUMN intake_answers TEXT', (error) => {
    if (error && !String(error.message || '').includes('duplicate column name')) {
      console.error('[clientDb] failed to add intake_answers:', error.message);
    }
  });

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

const ingestionLog = [];
const matcherLog = [];
const modernizationLog = [];
const riskLog = [];
const forecastingLog = [];
const prioritizationLog = [];
let automationEnabled = false;
const automationConfig = { ingestion: false, forecasting: false, prioritization: false };
const automationLog = [];
const killSwitch = { global: false, ingestion: false, matcher: false, modernization: false, risk: false, forecasting: false, prioritization: false, automation: false };
const auditStream = [];

function isKilled(engine) {
  return killSwitch.global || killSwitch[engine];
}

function audit(event) {
  const entry = { event, timestamp: new Date().toISOString() };
  auditStream.push(entry);
  if (auditStream.length > 500) auditStream.shift();
  return entry;
}

function logIngestion(type, count) {
  const timestamp = new Date().toISOString();
  const entry = { type, count, startedAt: timestamp, finishedAt: timestamp, status: 'OK' };
  ingestionLog.push(entry);
  if (ingestionLog.length > 100) ingestionLog.shift();
  return entry;
}

function logMatcher(clientId, resultCount) {
  const timestamp = new Date().toISOString();
  const entry = { clientId, resultCount, startedAt: timestamp, finishedAt: timestamp, status: 'OK' };
  matcherLog.push(entry);
  if (matcherLog.length > 100) matcherLog.shift();
  return entry;
}

function logModernization(clientId, posture, blockers) {
  const timestamp = new Date().toISOString();
  const entry = { clientId, posture, blockers, startedAt: timestamp, finishedAt: timestamp, status: 'OK' };
  modernizationLog.push(entry);
  if (modernizationLog.length > 100) modernizationLog.shift();
  return entry;
}

function logRisk(clientId, posture, risks) {
  const timestamp = new Date().toISOString();
  const entry = { clientId, posture, risks, startedAt: timestamp, finishedAt: timestamp, status: 'OK' };
  riskLog.push(entry);
  if (riskLog.length > 100) riskLog.shift();
  return entry;
}

function logForecast(clientId, signals, trends, outlook) {
  const timestamp = new Date().toISOString();
  const entry = { clientId, signals, trends, outlook, startedAt: timestamp, finishedAt: timestamp, status: 'OK' };
  forecastingLog.push(entry);
  if (forecastingLog.length > 100) forecastingLog.shift();
  return entry;
}

function logPrioritization(clientId, topCount) {
  const timestamp = new Date().toISOString();
  const entry = { clientId, topCount, startedAt: timestamp, finishedAt: timestamp, status: 'OK' };
  prioritizationLog.push(entry);
  if (prioritizationLog.length > 100) prioritizationLog.shift();
  return entry;
}

function logAutomation(event) {
  const entry = { event, timestamp: new Date().toISOString() };
  automationLog.push(entry);
  if (automationLog.length > 100) automationLog.shift();
  return entry;
}

function runAdvisoryForecast(clientId) {
  const signals = ['HHS spending up', 'DOE digital expansion'];
  const trends = ['Upward', 'Stable'];
  const outlook = 'Positive';
  return logForecast(clientId, signals, trends, outlook);
}

async function runAdvisoryPrioritization(clientId) {
  const results = await prioritizedResults(clientId, true);
  return logPrioritization(clientId, results.opportunities.length + results.grants.length);
}

const automationScheduler = setInterval(async () => {
  if (!automationEnabled || isKilled('automation')) return;
  if (automationConfig.ingestion) {
    if (isKilled('ingestion')) audit('Auto-ingestion skipped: kill switch active');
    else { logIngestion('opportunities', 312); logAutomation('Auto-ingestion executed'); audit('Auto-ingestion executed'); }
  }
  if (automationConfig.forecasting) {
    if (isKilled('forecasting')) audit('Auto-forecast skipped: kill switch active');
    else { runAdvisoryForecast('1'); logAutomation('Auto-forecast executed'); audit('Auto-forecast executed'); }
  }
  if (automationConfig.prioritization) {
    if (isKilled('prioritization')) audit('Auto-prioritization skipped: kill switch active');
    else { await runAdvisoryPrioritization('1'); logAutomation('Auto-prioritization executed'); audit('Auto-prioritization executed'); }
  }
}, 60_000);
automationScheduler.unref();

function htmlLayout({ title, content, includeNav = true, extraHead = '', statusClass = '', showStatusStrip = true }) {
  const nav = includeNav
    ? `
      <nav class="top-nav">
        <div class="brand"><a href="/" style="color:inherit;text-decoration:none;">JE ROCKER LC</a></div>
        <div class="top-nav-links">
          <a href="/cover">Cover Page</a>
          <a href="/business-driver">Business Driver</a>
          <a href="/govtech-dashboard">GovTech Ops</a>
          <a href="/govtech-pipeline">CRM Pipeline</a>
          <a href="/govtech-intake">Client Intake</a>
          <a href="/client-dashboard">Client Dashboard</a>
          <a href="/primary-dashboard">Primary Dashboard</a>
          <a href="/grant-neural-engine">Grant Neural Engine</a>
          <a href="/govtech">Public Site</a>
          <a href="/" style="margin-left:auto;color:#38bdf8;font-weight:700;">⌂ Main Portal</a>
        </div>
      </nav>
    `
    : '';

  const statusStrip = `
    <section class="global-status-strip ${statusClass}" aria-label="System status strip">
      <div class="global-status-item ${statusClass ? 'sys-block' : ''}"><span class="global-status-label">System</span><span class="global-status-value" id="global-system-status">Loading...</span></div>
      <div class="global-status-item ${statusClass ? 'sys-block' : ''}"><span class="global-status-label">Last Scraper</span><span class="global-status-value" id="global-last-scraper">Loading...</span></div>
      <div class="global-status-item ${statusClass ? 'sys-block' : ''}"><span class="global-status-label">Last Matcher</span><span class="global-status-value" id="global-last-matcher">Loading...</span></div>
      <div class="global-status-item ${statusClass ? 'sys-block' : ''}"><span class="global-status-label">Last Updated</span><span class="global-status-value" id="global-last-updated">Loading...</span></div>
      <div class="global-status-item global-status-nodes ${statusClass ? 'sys-block' : ''}"><span class="global-status-label">Cluster</span><span class="global-status-value" id="global-cluster-nodes">Loading...</span></div>
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
          ${showStatusStrip ? statusStrip : ''}
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
      <script src="/src/scripts/dashboard.js" defer></script>
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

async function loadPipelineCounts() {
  const opportunitiesPath = path.join(PIPELINE_ROOT, 'db', 'opportunities.db');
  const matchesPath = path.join(PIPELINE_ROOT, 'db', 'matches.db');
  if (!fs.existsSync(opportunitiesPath) || !fs.existsSync(matchesPath)) return null;

  const pipelineOpp = new sqlite3.Database(opportunitiesPath, sqlite3.OPEN_READONLY);
  const pipelineMatches = new sqlite3.Database(matchesPath, sqlite3.OPEN_READONLY);
  try {
    const [opportunities, matches] = await Promise.all([
      getAsync(pipelineOpp, 'SELECT COUNT(*) AS count FROM opportunities'),
      getAsync(pipelineMatches, 'SELECT COUNT(*) AS count FROM matches'),
    ]);
    return { opportunities: toNumber(opportunities?.count), matches: toNumber(matches?.count) };
  } catch {
    return null;
  } finally {
    pipelineOpp.close();
    pipelineMatches.close();
  }
}

async function searchPipelineOpportunities(query, limit = 20) {
  const opportunitiesPath = path.join(PIPELINE_ROOT, 'db', 'opportunities.db');
  if (!fs.existsSync(opportunitiesPath)) return [];

  const pipelineOpp = new sqlite3.Database(opportunitiesPath, sqlite3.OPEN_READONLY);
  const like = `%${String(query).toLowerCase()}%`;
  try {
    return await allAsync(pipelineOpp, `
      SELECT notice_id, title, agency, naics_code, psc_code, response_date, url
      FROM opportunities
      WHERE lower(title) LIKE ? OR lower(agency) LIKE ? OR lower(notice_id) LIKE ?
      ORDER BY scraped_at DESC
      LIMIT ?
    `, [like, like, like, limit]);
  } catch {
    return [];
  } finally {
    pipelineOpp.close();
  }
}

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

  const pipelineCounts = await loadPipelineCounts();
  const localMatches = toNumber(primaryCountRow?.count) + toNumber(reviewCountRow?.count);
  const totalMatches = pipelineCounts?.matches || localMatches;
  const matchedOpportunities = toNumber(primaryCountRow?.count);
  const totalOpportunities = pipelineCounts?.opportunities || toNumber(oppCountRow?.count);
  const matchCoverage = totalOpportunities > 0 ? ((matchedOpportunities / totalOpportunities) * 100).toFixed(1) : '0.0';
    const pipelineScraperRun = lastModifiedAt(path.join(PIPELINE_ROOT, 'db', 'opportunities.db'));
    const pipelineMatcherRun = lastModifiedAt(path.join(PIPELINE_ROOT, 'db', 'matches.db'));

  return {
      total_opportunities: totalOpportunities,
      live_index_opportunities: LIVE_INDEX_OPPORTUNITIES,
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

app.get('/api/drift/dsm', (req, res) => {
  res.json({ DSM });
});

async function loadForecastTimeseries(table) {
  const allowed = new Set([
    'forecast_pipeline_timeseries',
    'forecast_grants_timeseries',
    'forecast_modernization_timeseries',
  ]);
  if (!allowed.has(table) || !fs.existsSync(FORECAST_DB_PATH)) return [];

  const database = new sqlite3.Database(FORECAST_DB_PATH, sqlite3.OPEN_READONLY);
  try {
    return await allAsync(database, `SELECT * FROM ${table} ORDER BY bucket_date ASC, id ASC`);
  } finally {
    database.close();
  }
}

app.get('/api/forecast/data/pipeline', async (req, res) => {
  try {
    res.json({ items: await loadForecastTimeseries('forecast_pipeline_timeseries') });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/forecast/data/grants', async (req, res) => {
  try {
    res.json({ items: await loadForecastTimeseries('forecast_grants_timeseries') });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/forecast/data/modernization', async (req, res) => {
  try {
    res.json({ items: await loadForecastTimeseries('forecast_modernization_timeseries') });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function runForecast(kind) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'forecast_engine.py'), kind],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Forecast engine returned invalid JSON'));
        }
      },
    );
  });
}

function loadGneSnapshot({ runFull = false } = {}) {
  return new Promise((resolve, reject) => {
    const gnePython = process.env.GNE_PYTHON_BIN || (fs.existsSync(path.join(__dirname, '.venv', 'bin', 'python')) ? path.join(__dirname, '.venv', 'bin', 'python') : '/usr/bin/python3');
    const args = [path.join(__dirname, 'core', 'api', 'gne_snapshot.py')];
    if (runFull) args.push('--run-full');
    execFile(
      gnePython,
      args,
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: __dirname },
        maxBuffer: 128 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('GNE pipeline returned invalid JSON'));
        }
      },
    );
  });
}

let gneRefreshPromise = null;

function refreshGneSnapshot() {
  if (!gneRefreshPromise) {
    gneRefreshPromise = loadGneSnapshot({ runFull: true }).finally(() => {
      gneRefreshPromise = null;
    });
  }
  return gneRefreshPromise;
}

app.get('/api/gne/state', async (req, res) => {
  try {
    res.json(await loadGneSnapshot());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/gne/refresh', async (req, res) => {
  try {
    res.json(await refreshGneSnapshot());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

registerHeadhunterRoutes(app, htmlLayout);
registerGovtechCommercialRoutes(app);

app.get('/grant-neural-engine', (req, res) => {
  const content = `
    <main class="gne-page">
      <header class="gne-page-header"><div><p>Grant Neural Engine</p><h1>Funding Signal Cockpit</h1><span>Signals, meaning, cycles, modernization, and ecosystem intelligence</span></div><button type="button" id="gne-refresh">Refresh GNE</button></header>
      <p id="gne-status" class="gne-status" role="status">Loading Grant Neural Engine...</p>
      <section class="gne-panel gne-summary-panel"><h2>Grant Neural Engine Summary</h2><div id="gne-summary" class="gne-summary-grid"></div><div id="gne-sources" class="gne-source-breakdown"></div></section>
      <div class="gne-primary-grid">
        <section class="gne-panel gne-signals-panel"><h2>Grant Signals</h2><div id="gne-signals"></div></section>
        <section class="gne-panel"><h2>Funding Forecasts</h2><div id="gne-forecasts" class="gne-tile-list"></div></section>
      </div>
      <div class="gne-secondary-grid">
        <section class="gne-panel"><h2>Modernization Intelligence</h2><div id="gne-modernization" class="gne-tile-list"></div></section>
        <section class="gne-panel"><h2>Partner Ecosystems</h2><div id="gne-partners" class="gne-tile-list"></div></section>
      </div>
    </main>
    <div id="gne-modal" class="gne-modal hidden" role="dialog" aria-modal="true" aria-labelledby="gne-modal-title"><article class="gne-modal-content"><button type="button" id="gne-modal-close" aria-label="Close signal detail">×</button><h3 id="gne-modal-title"></h3><p id="gne-modal-text"></p></article></div>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const keyOf = (item) => [item.source || '', item.title || '', item.published_date || ''].join('|');
        const empty = (message) => '<p class="gne-empty">' + message + '</p>';
        const tags = (items) => '<div class="gne-tags">' + (items || []).map((item) => '<span>' + escapeHtml(item) + '</span>').join('') + '</div>';
        const PAGE_SIZE = 50;
        const renderPaged = (containerId, items, renderItems, emptyMessage, afterRender) => {
          const container = document.getElementById(containerId);
          let page = 0;
          const draw = () => {
            if (!items.length) {
              container.innerHTML = empty(emptyMessage);
              return;
            }
            const pageCount = Math.ceil(items.length / PAGE_SIZE);
            page = Math.max(0, Math.min(page, pageCount - 1));
            const start = page * PAGE_SIZE;
            const end = Math.min(start + PAGE_SIZE, items.length);
            container.innerHTML = renderItems(items.slice(start, end), start) + '<nav class="gne-pager" aria-label="' + escapeHtml(containerId.replace('gne-', '')) + ' pagination"><span>' + (start + 1) + '-' + end + ' of ' + items.length + '</span><div><button type="button" data-gne-prev' + (page === 0 ? ' disabled' : '') + '>Previous</button><button type="button" data-gne-next' + (page === pageCount - 1 ? ' disabled' : '') + '>Next</button></div></nav>';
            container.querySelector('[data-gne-prev]').addEventListener('click', () => { page -= 1; draw(); });
            container.querySelector('[data-gne-next]').addEventListener('click', () => { page += 1; draw(); });
            if (afterRender) afterRender();
          };
          draw();
        };
        const modal = document.getElementById('gne-modal');
        const closeModal = () => modal.classList.add('hidden');
        document.getElementById('gne-modal-close').addEventListener('click', closeModal);
        modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
        const showSignal = (signal) => {
          document.getElementById('gne-modal-title').textContent = signal.title || 'Grant signal';
          document.getElementById('gne-modal-text').textContent = signal.raw_text || 'No article text available.';
          modal.classList.remove('hidden');
        };
        const tile = (title, body) => '<article class="gne-tile"><h3>' + escapeHtml(title) + '</h3>' + body + '</article>';
        document.getElementById('gne-refresh').addEventListener('click', async (event) => {
          const button = event.currentTarget;
          const status = document.getElementById('gne-status');
          button.disabled = true;
          button.textContent = 'Refreshing...';
          status.textContent = 'Refreshing all GNE sources...';
          try {
            const response = await fetch('/api/gne/refresh', { method: 'POST' });
            if (!response.ok) throw new Error('GNE refresh failed');
            window.location.reload();
          } catch (error) {
            status.textContent = error.message;
            button.disabled = false;
            button.textContent = 'Refresh GNE';
          }
        });

        fetch('/api/gne/state', { cache: 'no-store' }).then((response) => {
          if (!response.ok) throw new Error('GNE state unavailable');
          return response.json();
        }).then((data) => {
          const signals = Array.isArray(data.gne_signals) ? data.gne_signals : [];
          const semantics = Array.isArray(data.gne_semantics) ? data.gne_semantics : [];
          const classifications = Array.isArray(data.gne_classifications) ? data.gne_classifications : [];
          const forecasts = Array.isArray(data.gne_forecasts) ? data.gne_forecasts : [];
          const modernization = Array.isArray(data.gne_modernization) ? data.gne_modernization : [];
          const partners = Array.isArray(data.gne_partners) ? data.gne_partners : [];
          const semanticMap = new Map(semantics.map((item) => [keyOf(item), item]));
          const classificationMap = new Map(classifications.map((item) => [keyOf(item), item]));
          const forecastMap = new Map(forecasts.map((item) => [keyOf(item), item]));
          const sourceCounts = signals.reduce((counts, signal) => { counts[signal.source] = (counts[signal.source] || 0) + 1; return counts; }, {});
          document.getElementById('gne-summary').innerHTML = [
            [signals.length, 'Signals'], [forecasts.length, 'Forecasts'],
            [modernization.filter((item) => item.cycle?.type === 'modernization').length, 'Modernization cycles'],
            [partners.filter((item) => item.partners?.length).length, 'Partner ecosystems'],
          ].map(([value, label]) => '<div><strong>' + value + '</strong><span>' + label + '</span></div>').join('');
          const sourceNames = Object.keys(sourceCounts).sort();
          document.getElementById('gne-sources').innerHTML = sourceNames.length ? sourceNames.map((source) => '<span>' + escapeHtml(source) + ': ' + sourceCounts[source] + '</span>').join('') : '<span>No sources loaded</span>';

          const rows = signals.map((signal) => {
            const key = keyOf(signal); const semantic = semanticMap.get(key) || {}; const classification = classificationMap.get(key) || {}; const forecast = forecastMap.get(key) || {};
            return { ...signal, funding_amount: semantic.funding_amount, categories: classification.categories || [], probability: forecast.probability };
          });
          renderPaged('gne-signals', rows, (pageRows, start) => '<div class="gne-table-wrap"><table><thead><tr><th>Source</th><th>Title</th><th>Published</th><th>Funding</th><th>Categories</th><th>Probability</th></tr></thead><tbody>' + pageRows.map((row, index) => '<tr tabindex="0" data-gne-row="' + (start + index) + '"><td>' + escapeHtml(row.source) + '</td><td>' + escapeHtml(row.title) + '</td><td>' + escapeHtml(row.published_date) + '</td><td>' + (row.funding_amount == null ? 'Not extracted' : '$' + Number(row.funding_amount).toLocaleString()) + '</td><td>' + escapeHtml(row.categories.join(', ') || 'general') + '</td><td>' + (row.probability == null ? 'N/A' : Math.round(row.probability * 100) + '%') + '</td></tr>').join('') + '</tbody></table></div>', 'No grant signals available.', () => {
            document.querySelectorAll('[data-gne-row]').forEach((row) => { const open = () => showSignal(rows[Number(row.dataset.gneRow)]); row.addEventListener('click', open); row.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); }); });
          });
          renderPaged('gne-forecasts', forecasts, (pageItems) => pageItems.map((item) => tile(item.title, '<dl><div><dt>Cycle</dt><dd>' + escapeHtml(item.cycle?.cycle_type || 'Unknown') + '</dd></div><div><dt>Probability</dt><dd>' + Math.round((item.probability || 0) * 100) + '%</dd></div><div><dt>Volatility</dt><dd>' + escapeHtml(item.volatility || 'Unknown') + '</dd></div><div><dt>Expected release</dt><dd>' + escapeHtml(item.timeline?.expected_release_quarter || 'Unknown') + '</dd></div></dl>')).join(''), 'No GNE forecasts available.');
          renderPaged('gne-modernization', modernization, (pageItems) => pageItems.map((item) => tile(item.title, '<p>Density <strong>' + Math.round((item.density || 0) * 100) + '%</strong> · Relevance <strong>' + (item.relevance || 0) + '</strong></p><p>' + (item.cycle?.type === 'modernization' ? escapeHtml(item.cycle.start + ' to ' + item.cycle.end) : 'No modernization cycle detected') + '</p>' + tags(item.alignment))).join(''), 'No modernization intelligence available.');
          renderPaged('gne-partners', partners, (pageItems) => pageItems.map((item) => tile(item.title, '<p>Density <strong>' + Math.round((item.ecosystem_density || 0) * 100) + '%</strong> · Relevance <strong>' + (item.relevance || 0) + '</strong></p><ul>' + (item.partners || []).map((partner) => '<li>' + escapeHtml(partner) + '</li>').join('') + '</ul>' + tags(item.alignment))).join(''), 'No partner ecosystems available.');
          document.getElementById('gne-status').textContent = '';
        }).catch((error) => { document.getElementById('gne-status').textContent = error.message; });
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER - Grant Neural Engine', content, statusClass: 'system-row' }));
});

function runForecastNarrative(kind) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'forecast_narrative.py'), kind],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Forecast narrative engine returned invalid JSON'));
        }
      },
    );
  });
}

function runStrategicBriefing() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'strategic_briefing.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Strategic briefing engine returned invalid JSON'));
        }
      },
    );
  });
}

function runClientBriefing(clientId) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'client_briefing.py'), String(clientId)],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let payload;
        try {
          payload = JSON.parse(stdout);
        } catch {
          return reject(new Error(stderr || 'Client briefing engine returned invalid JSON'));
        }
        if (error && payload.error === 'Client not found') return resolve(null);
        if (error) return reject(new Error(stderr || error.message));
        resolve(payload);
      },
    );
  });
}

function runPortfolioBriefing() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_briefing.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio briefing engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioActions() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_actions.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio action engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioActionQueue() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_action_queue.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio action queue engine returned invalid JSON'));
        }
      },
    );
  });
}

function runActionPlaybooks() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'action_playbooks.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Action playbook engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioCycle() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_cycle.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio cycle engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioCycleTrends() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_cycle_trends.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio cycle trend engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioCycleMomentum() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_cycle_momentum.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio cycle momentum engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioStability() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_stability.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio stability engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioStabilityForecast() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_stability_forecast.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio stability forecast engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioStabilityAdvisory() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_stability_advisory.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio stability advisory engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioResilience() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_resilience.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio resilience engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioResilienceForecast() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_resilience_forecast.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio resilience forecast engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioResilienceAdvisory() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_resilience_advisory.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio resilience advisory engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioShock() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_shock.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio shock engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioShockForecast() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_shock_forecast.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio shock forecast engine returned invalid JSON'));
        }
      },
    );
  });
}

function runPortfolioShockAdvisory() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'portfolio_shock_advisory.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Portfolio shock advisory engine returned invalid JSON'));
        }
      },
    );
  });
}

function runIntelligenceOverview() {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [path.join(__dirname, 'scripts', 'intelligence_overview.py')],
      {
        cwd: __dirname,
        env: { ...process.env, PYTHONPATH: path.join(__dirname, 'scripts') },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Intelligence overview engine returned invalid JSON'));
        }
      },
    );
  });
}

app.get('/api/forecast/pipeline', async (req, res) => {
  try {
    res.json(await runForecast('pipeline'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/forecast/grants', async (req, res) => {
  try {
    res.json(await runForecast('grants'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/forecast/modernization', async (req, res) => {
  try {
    res.json(await runForecast('modernization'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/forecast/narrative/pipeline', async (req, res) => {
  try {
    res.json(await runForecastNarrative('pipeline'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/forecast/narrative/grants', async (req, res) => {
  try {
    res.json(await runForecastNarrative('grants'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/forecast/narrative/modernization', async (req, res) => {
  try {
    res.json(await runForecastNarrative('modernization'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/briefing', async (req, res) => {
  try {
    res.json({ briefing: await runStrategicBriefing() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/briefing/client/:clientId', async (req, res) => {
  const clientId = Number.parseInt(String(req.params.clientId || ''), 10);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    return res.status(400).json({ error: 'A valid client id is required' });
  }
  try {
    const briefing = await runClientBriefing(clientId);
    if (!briefing) return res.status(404).json({ error: 'Client not found' });
    res.json({ briefing });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/briefing/portfolio', async (req, res) => {
  try {
    res.json({ briefing: await runPortfolioBriefing() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/actions', async (req, res) => {
  try {
    res.json(await runPortfolioActions());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/action-queue', async (req, res) => {
  try {
    res.json(await runPortfolioActionQueue());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/playbooks', async (req, res) => {
  try {
    res.json(await runActionPlaybooks());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/cycle', async (req, res) => {
  try {
    res.json(await runPortfolioCycle());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/cycle-trends', async (req, res) => {
  try {
    res.json(await runPortfolioCycleTrends());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/cycle-momentum', async (req, res) => {
  try {
    res.json(await runPortfolioCycleMomentum());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/stability', async (req, res) => {
  try {
    res.json(await runPortfolioStability());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/stability-forecast', async (req, res) => {
  try {
    res.json(await runPortfolioStabilityForecast());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/stability-advisory', async (req, res) => {
  try {
    res.json(await runPortfolioStabilityAdvisory());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/resilience', async (req, res) => {
  try {
    res.json(await runPortfolioResilience());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/resilience-forecast', async (req, res) => {
  try {
    res.json(await runPortfolioResilienceForecast());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/resilience-advisory', async (req, res) => {
  try {
    res.json(await runPortfolioResilienceAdvisory());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/shock', async (req, res) => {
  try {
    res.json(await runPortfolioShock());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/shock-forecast', async (req, res) => {
  try {
    res.json(await runPortfolioShockForecast());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/shock-advisory', async (req, res) => {
  try {
    res.json(await runPortfolioShockAdvisory());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio/intelligence-overview', async (req, res) => {
  try {
    res.json(await runIntelligenceOverview());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/drift/test', (req, res) => {
  res.json(applyDriftSuppression(req.body || {}));
});

function mockSearchDatabase(keyword) {
  return keyword;
}

function mockSearchOpportunities(keyword) {
  return keyword;
}

function mockSearchState(state, keyword) {
  return keyword || state;
}

function mockSearchGlobal(keyword) {
  return keyword;
}

function filterSearchRowsByState(rows, state) {
  if (!state) return rows;
  const matchesState = (row) => {
    const values = [row.state, row.stateCode, row.state_code, row.place_of_performance_state, row.placeOfPerformanceState, row.location, row.address].filter(Boolean);
    return values.some((value) => String(value).toUpperCase().split(/[^A-Z]+/).includes(state));
  };
  if (Array.isArray(rows)) return rows.filter(matchesState);
  if (rows && typeof rows === 'object') return Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, Array.isArray(value) ? value.filter(matchesState) : value]));
  return rows;
}

app.get('/api/internal_search', async (req, res) => {
  const requestedScope = String(req.query.scope || 'global').trim().toLowerCase();
  const scope = ['database', 'opportunities', 'state'].includes(requestedScope) ? requestedScope : 'global';
  const keyword = String(req.query.q || '').trim();
  const state = String(req.query.state || '').trim().toUpperCase();
  const query = scope === 'database'
    ? mockSearchDatabase(keyword)
    : scope === 'opportunities'
      ? mockSearchOpportunities(keyword)
      : scope === 'state'
        ? mockSearchState(state, keyword)
        : mockSearchGlobal(keyword);
  const type = classifySearch(query);
  const resultCount = (rows) => Array.isArray(rows)
    ? rows.length
    : Object.values(rows || {}).reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0);
  const respond = (responseType, rows) => {
    const scopedRows = scope === 'state' ? filterSearchRowsByState(rows, state) : rows;
    return res.json({
    scope,
    state,
    keyword,
    searchMode: scope === 'state' ? 'state' : 'federal',
    count: resultCount(scopedRows),
    results: scopedRows,
    type: responseType,
    rows: scopedRows,
    });
  };

  if (!query) {
    return respond('empty', []);
  }

  if (query.length < 2) {
    return respond('short_query', []);
  }

  try {
    const liveItems = [...await loadLiveOpportunities(), ...await loadLiveGrants()];
    const scopedLiveItems = liveItems
      .filter((item) => scope === 'state' ? item.source === 'state' && (!state || item.stateCode === state) : item.source === 'federal')
      .filter((item) => matchesQuery(item, keyword || query));
    if (scopedLiveItems.length || scope === 'state' || scope === 'opportunities') {
      return respond(scope === 'state' ? 'state' : 'federal', scopedLiveItems.slice(0, 50));
    }
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
      if (!agencyNameCol) return respond(type, []);
      const rows = await allAsync(fpds, `
        SELECT ${agencyNameCol} AS name, ${agencyCountCol} AS count, ${agencyObCol} AS obligated
        FROM fpds_intel_agencies
        WHERE lower(${agencyNameCol}) LIKE ?
        ORDER BY obligated DESC
        LIMIT 20
      `, [like]);
      return respond(type, stabilizeSearchRows(rows));
    }

    if (type === 'vendor') {
      if (!vendorNameCol) return respond(type, []);
      const rows = await allAsync(fpds, `
        SELECT ${vendorNameCol} AS name, ${vendorCountCol} AS count, ${vendorObCol} AS obligated
        FROM fpds_intel_vendors
        WHERE lower(${vendorNameCol}) LIKE ?
        ORDER BY obligated DESC
        LIMIT 20
      `, [like]);
      return respond(type, stabilizeSearchRows(rows));
    }

    if (type === 'naics') {
      if (!naicsCodeCol) return respond(type, []);
      const rows = await allAsync(fpds, `
        SELECT ${naicsCodeCol} AS code, ${naicsCountCol} AS count, ${naicsObCol} AS obligated
        FROM fpds_intel_naics
        WHERE ${naicsCodeCol} LIKE ?
        ORDER BY obligated DESC
        LIMIT 20
      `, [`%${query.replace(/[^0-9]/g, '')}%`]);
      return respond(type, stabilizeSearchRows(rows));
    }

    if (type === 'psc') {
      if (!pscCodeCol) return respond(type, []);
      const p = query.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const rows = await allAsync(fpds, `
        SELECT ${pscCodeCol} AS code, ${pscCountCol} AS count, ${pscObCol} AS obligated
        FROM fpds_intel_psc
        WHERE upper(${pscCodeCol}) LIKE ?
        ORDER BY obligated DESC
        LIMIT 20
      `, [`%${p}%`]);
      return respond(type, stabilizeSearchRows(rows));
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

      return respond(type, stabilizeSearchRows({ opportunities: oppRows, matches: matchRows }));
    }

    if (type === 'award') {
      const rows = await allAsync(matches, `
        SELECT id, fpds_contract_id, fpds_contract_key, opportunity_title, fpds_agency, incumbent_vendor, incumbent_award_value
        FROM matches
        WHERE lower(fpds_contract_id) LIKE ? OR lower(fpds_contract_key) LIKE ?
        ORDER BY id DESC
        LIMIT 20
      `, [like, like]);
      return respond(type, stabilizeSearchRows(rows));
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
      return respond(type, stabilizeSearchRows(rows));
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

    const pipelineRows = rows.length ? [] : await searchPipelineOpportunities(query);
    respond(
      'keyword',
      stabilizeSearchRows(pipelineRows.length ? pipelineRows.map((row) => ({ bucket: 'opportunity', ...row })) : rows),
    );
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
    const narrative = module === 'opportunities' ? await runForecastNarrative('pipeline') : { items: [] };

    res.json({
      ...payload,
      opportunities: stabilizeItems(payload.opportunities),
      narrative: narrative.items,
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

app.get('/api/forecast/client/:clientId', async (req, res) => {
  try {
    const clientId = Number.parseInt(String(req.params.clientId || ''), 10);
    if (!Number.isFinite(clientId) || clientId <= 0) {
      return res.status(400).json({ error: 'A valid client id is required' });
    }

    const client = await getAsync(clientDb, 'SELECT * FROM clients WHERE client_id = ?', [clientId]);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const naics = new Set(splitClientList(client.naics || '').map((value) => value.toLowerCase()));
    const agencies = new Set(splitClientList(client.preferred_agencies || '').map((value) => value.toLowerCase()));
    const forecast = await runForecast('pipeline');
    const items = forecast.items.filter((item) => {
      const naicsMatch = naics.size === 0 || naics.has(String(item.stableNaics || '').toLowerCase());
      const agencyMatch = agencies.size === 0 || agencies.has(String(item.stableAgency || '').toLowerCase());
      return naicsMatch && agencyMatch;
    });

    res.json({ items, client_id: clientId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const COCKPIT_MOCK_CLIENTS = {
  ClientA: { name: 'Client A', tier: 'Tier 1', industry: 'Healthcare', region: 'VA', agency: 'HHS', scores: { modernization: 82, match: 76, risk: 18 }, intelligence: { compliance: 'Good', modernization: 'Strong', forecasting: 'Aligned', opportunityAlignment: 'High', readiness: 'Medium', momentum: 'Increasing' }, opportunities: { top10: ['Opportunity 1', 'Opportunity 2'], fullFeed: ['Opp A', 'Opp B', 'Opp C'], agencies: ['HHS', 'DOE'], windows: ['Q4 2026', 'Q1 2027'] }, actions: { modernization: ['Update website', 'Rewrite capability statement'], compliance: ['SAM renewal', 'UEI verification'], outreach: ['Email HHS', 'Call DOE'], submission: ['Prepare bid package'], notes: ['Client prefers Tuesday calls'] } },
  ClientB: { name: 'Client B', tier: 'Tier 2', industry: 'Education', region: 'CA', agency: 'DOE', scores: { modernization: 65, match: 70, risk: 25 }, intelligence: { compliance: 'Good', modernization: 'Moderate', forecasting: 'Watch', opportunityAlignment: 'Medium', readiness: 'Medium', momentum: 'Stable' }, opportunities: { top10: ['Opportunity 1', 'Opportunity 2'], fullFeed: ['Opp A', 'Opp B', 'Opp C'], agencies: ['HHS', 'DOE'], windows: ['Q4 2026', 'Q1 2027'] }, actions: { modernization: ['Update website', 'Rewrite capability statement'], compliance: ['SAM renewal', 'UEI verification'], outreach: ['Email HHS', 'Call DOE'], submission: ['Prepare bid package'], notes: ['Client prefers Tuesday calls'] } },
  ClientC: { name: 'Client C', tier: 'Premium', industry: 'Defense', region: 'TX', agency: 'DOD', scores: { modernization: 90, match: 88, risk: 12 }, intelligence: { compliance: 'Strong', modernization: 'Strong', forecasting: 'Aligned', opportunityAlignment: 'High', readiness: 'High', momentum: 'Increasing' }, opportunities: { top10: ['Opportunity 1', 'Opportunity 2'], fullFeed: ['Opp A', 'Opp B', 'Opp C'], agencies: ['HHS', 'DOE'], windows: ['Q4 2026', 'Q1 2027'] }, actions: { modernization: ['Update website', 'Rewrite capability statement'], compliance: ['SAM renewal', 'UEI verification'], outreach: ['Email HHS', 'Call DOE'], submission: ['Prepare bid package'], notes: ['Client prefers Tuesday calls'] } },
};

app.get('/api/client/:id/opportunities', (req, res) => {
  res.json({
    top10: ['Opportunity 1', 'Opportunity 2'],
    fullFeed: ['Opp A', 'Opp B', 'Opp C'],
    agencies: ['HHS', 'DOE'],
    windows: ['Q4 2026', 'Q1 2027'],
  });
});

app.get('/api/client/:id/actions', (req, res) => {
  res.json({
    modernization: ['Update website', 'Rewrite capability statement'],
    compliance: ['SAM renewal', 'UEI verification'],
    outreach: ['Email HHS', 'Call DOE'],
    submission: ['Prepare bid package'],
    notes: ['Client prefers Tuesday calls'],
  });
});

app.get('/api/client/:id/intelligence', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.params.id || ''));
  const scoreLabel = (value) => Number(value || 0) >= 70 ? 'Strong' : Number(value || 0) >= 50 ? 'Developing' : 'Needs review';
  res.json({ compliance: scoreLabel(summary.signals.compliance), modernization: scoreLabel(summary.signals.modernization), forecasting: summary.counts.opportunities || summary.counts.grants ? 'Live' : 'Unavailable', opportunityAlignment: scoreLabel(summary.score), readiness: scoreLabel(summary.signals.readiness), momentum: scoreLabel(summary.signals.momentum) });
});

app.get('/engine/client/:id/modernization', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.params.id || ''));
  const blockers = Object.entries(summary.axisScores || {}).filter(([, score]) => Number(score) < 50).map(([axis]) => axis + ' alignment needs review');
  res.json({ score: summary.signals.modernization, posture: Number(summary.signals.modernization || 0) >= 70 ? 'Strong' : 'Developing', blockers, recommendations: summary.opportunities.slice(0, 2).map((item) => 'Review modernization fit for ' + item.title) });
});

app.get('/engine/client/:id/matcher', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.params.id || ''));
  res.json({ alignmentScore: summary.score, alignedAgencies: [...new Set(summary.opportunities.map((item) => item.agency).filter(Boolean))].slice(0, 10), alignedOpportunities: summary.opportunities.slice(0, 10).map((item) => item.title) });
});

app.get('/engine/client/:id/risk', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.params.id || ''));
  const score = Number(summary.signals.risk || 0);
  res.json({ score, level: score >= 70 ? 'High' : score >= 40 ? 'Moderate' : 'Low', factors: Object.entries(summary.axisScores || {}).filter(([, value]) => Number(value) < 50).map(([axis]) => axis + ' alignment below target') });
});

app.get('/engine/client/:id/forecasting', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.params.id || ''));
  res.json({ momentum: summary.signals.momentum, readiness: summary.signals.readiness, signals: [summary.counts.opportunities + ' matched opportunities', summary.counts.grants + ' matched grants'], nextQuarter: summary.counts.opportunities || summary.counts.grants ? 'Live' : 'No live data' });
});

app.get('/engine/client/:id/opportunities', async (req, res) => {
  const client = await prioritizationClient(String(req.params.id || ''));
  const ranked = (await loadLiveOpportunities()).map((item) => scoreItem(item, client)).sort((a, b) => b.score - a.score);
  const agencies = [...new Set(ranked.map((item) => item.agency).filter(Boolean))];
  const now = new Date();
  const windows = [...new Set(ranked
    .map((item) => ({ label: item.deadline, parsed: parseDashboardDate(item.deadline || item.response_date) }))
    .filter((item) => item.label && item.parsed && item.parsed >= now)
    .sort((a, b) => a.parsed - b.parsed)
    .map((item) => String(item.label).slice(0, 10)))];
  res.json({ top10: ranked.slice(0, 10), fullFeed: ranked, agencies, windows });
});

app.get('/engine/client/:id/actions', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.params.id || ''));
  const topOpportunity = summary.opportunities[0]?.title || 'No top opportunity available';
  res.json({ modernization: ['Review modernization fit for ' + topOpportunity], compliance: ['Review live compliance score ' + summary.signals.compliance], outreach: summary.opportunities.slice(0, 2).map((item) => 'Review agency ' + (item.agency || 'Unknown')), submission: summary.opportunities.slice(0, 2).map((item) => 'Review deadline ' + (item.deadline || 'not listed')), notes: ['Generated from live client ingestion at ' + (summary.timestamp || 'not run')] });
});

function parseClientIntake(value) {
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

function clientListRow(row) {
  const intake = parseClientIntake(row.intake_answers);
  return {
    id: row.client_id,
    name: row.client_name,
    naics: row.naics || '',
    agencyPref: row.preferred_agencies || '',
    geo: intake.geo || '',
    keywords: row.keywords || '',
    ingestionStatus: row.live_ingestion_at ? 'Live ' + row.live_ingestion_at : 'Not run',
  };
}

async function readClientRecord(clientId) {
  const id = Number.parseInt(String(clientId || ''), 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return getAsync(clientDb, 'SELECT * FROM clients WHERE client_id = ?', [id]);
}

app.get('/clients', async (req, res) => {
  const rows = await allAsync(clientDb, 'SELECT * FROM clients ORDER BY client_name');
  res.json({ clients: rows.map(clientListRow) });
});

app.get('/clients/db', async (req, res) => {
  const rows = await allAsync(clientDb, 'SELECT * FROM clients ORDER BY client_name');
  const tableRows = rows.map((row) => {
    const client = clientListRow(row);
    return '<tr><td>' + escapeProfileHtml(client.name) + '</td><td>' + escapeProfileHtml(client.id) + '</td><td>' + escapeProfileHtml(client.naics) + '</td><td>' + escapeProfileHtml(client.agencyPref) + '</td><td>' + escapeProfileHtml(client.geo) + '</td><td>' + escapeProfileHtml(client.keywords) + '</td><td>' + escapeProfileHtml(client.ingestionStatus) + '</td><td><a href="/client/' + encodeURIComponent(client.id) + '/profile">Profile</a> <a href="/client/' + encodeURIComponent(client.id) + '/intake">Intake</a> <button type="button" data-run-client-ingestion="' + escapeProfileHtml(client.id) + '">Run Ingestion</button></td></tr>';
  }).join('');
  const content = '<main class="dashboard-page client-db-page"><section class="outer-block"><h1 class="panel-title">Client Database</h1><div class="inner-frame scrollable"><table class="client-db-table"><thead><tr><th>Name</th><th>ID</th><th>NAICS</th><th>Agency Pref</th><th>Geo</th><th>Keywords</th><th>Ingestion</th><th>Actions</th></tr></thead><tbody>' + tableRows + '</tbody></table></div></section></main><script>document.querySelectorAll("[data-run-client-ingestion]").forEach((button)=>button.addEventListener("click",async()=>{button.textContent="Running...";const response=await fetch("/engine/client-ingest/"+encodeURIComponent(button.dataset.runClientIngestion)+"/run",{method:"POST"});button.textContent=response.ok?"Ran":"Failed";}));</script>';
  res.send(htmlLayout({ title: 'JE ROCKER - Client Database', content, statusClass: 'system-row' }));
});

app.get('/client/:id/ingestion', async (req, res) => {
  try {
    res.json(await getClientIngestionSummary(String(req.params.id || '')));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

function detailResponse(title, components) {
  return { title, components };
}

async function clientDetailComponents(clientId, type) {
  const summary = await getClientIngestionSummary(clientId);
  const axis = summary.axisScores;
  const signals = summary.signals;
  const scoreOrReview = (score) => Number(score || 0) > 0 ? Number(score) : 'Needs review';
  const maps = {
    modernization: [['Modernization posture', scoreOrReview(signals.modernization), 'Keyword and NAICS-aligned modernization evidence', 'Review modernization language in top live opportunities', 'Refresh capability statement']],
    match: [['Opportunity match', scoreOrReview(summary.score), 'Composite NAICS, agency, geo, and keyword alignment', summary.opportunities.slice(0, 3).map((item) => item.title).join('; '), 'Pursue highest-scoring opportunities']],
    risk: [['Risk posture', scoreOrReview(signals.risk), 'Inverse of live alignment and readiness score', 'Compliance, operational, and technical factors from live profile', 'Mitigate weak alignment areas before pursuit']],
    compliance: [['Compliance posture', scoreOrReview(signals.compliance), 'Agency and profile readiness signals', 'Client profile and intake completeness', 'Verify SAM/UEI and update intake answers']],
    readiness: [['Client readiness', scoreOrReview(signals.readiness), 'Average of live match, agency, and keyword alignment', 'Live ingestion summary', 'Prioritize gaps with low axis scores']],
    momentum: [['Momentum', scoreOrReview(signals.momentum), 'Live opportunity and grant volume available', summary.counts.opportunities + ' opportunities, ' + summary.counts.grants + ' grants', 'Monitor new postings weekly']],
    forecasting: [['Forecasting', scoreOrReview(signals.momentum), 'Live counts and upcoming deadline windows', 'Top live opportunities and grants', 'Prepare near-term pursuit calendar']],
    alignment: [['NAICS alignment', scoreOrReview(axis.naics), 'NAICS overlap against live records', 'Client NAICS compared to live opportunities', 'Tune NAICS coverage'], ['Agency alignment', scoreOrReview(axis.agency), 'Preferred agency overlap', 'Preferred agencies compared to live agencies', 'Focus outreach on high-fit agencies'], ['Geo alignment', scoreOrReview(axis.geo), 'State/geo overlap', 'Intake geo compared to state records', 'Target local/state windows'], ['Keyword alignment', scoreOrReview(axis.keyword), 'Keyword overlap in title/description', 'Client keywords against live text', 'Refresh keywords']],
    ingestion: [['Matched opportunities', summary.counts.opportunities, 'Live opportunities scored for this client', summary.opportunities.slice(0, 5).map((item) => item.title + ' (' + item.score + ')').join('; '), 'Review top opportunity list'], ['Matched grants', summary.counts.grants, 'Live grants scored for this client', summary.grants.slice(0, 5).map((item) => item.title + ' (' + item.score + ')').join('; '), 'Review top grant list'], ['Ingestion timestamp', summary.timestamp || 'Not run', 'Last saved live ingestion summary', 'client.db live_ingestion_at', 'Run ingestion after data refresh']],
  };
  return (maps[type] || maps.alignment).map(([name, score, reason, evidence, recommendation, url]) => ({ name, score, reason, evidence, recommendation, url }));
}

['modernization', 'match', 'risk', 'compliance', 'readiness', 'momentum', 'forecasting', 'alignment'].forEach((type) => {
  app.get('/client/:id/' + type, async (req, res) => {
    try {
      res.json(detailResponse(type[0].toUpperCase() + type.slice(1) + ' Detail', await clientDetailComponents(String(req.params.id || ''), type)));
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });
});

function actionItemsFor(type, summary) {
  const topOpportunity = summary.opportunities[0];
  const base = {
    modernization: [
      ['Refresh capability statement', 'Modernization evidence is drawn from live opportunity language.', topOpportunity?.title || 'No top opportunity available', 'Update capability statement around live demand signals', summary.signals.modernization],
      ['Tune keywords', 'Keyword alignment contributes directly to readiness.', 'Keyword score ' + summary.axisScores.keyword, 'Update client keywords and intake notes', summary.axisScores.keyword],
    ],
    compliance: [
      ['Verify SAM and UEI', 'Compliance readiness supports live pursuit eligibility.', 'Compliance score ' + summary.signals.compliance, 'Confirm SAM renewal and UEI status', summary.signals.compliance],
      ['Review agency requirements', 'Top agencies may have specific compliance language.', topOpportunity?.agency || 'No agency available', 'Check solicitation instructions before pursuit', summary.axisScores.agency],
    ],
    outreach: [
      ['Contact top agency', 'Live matches indicate agency relevance.', topOpportunity?.agency || 'No agency available', 'Prepare outreach note using matched opportunity context', summary.axisScores.agency],
    ],
    checklist: [
      ['Review top opportunities', 'The live opportunity list changed from static counts to scored records.', summary.opportunities.slice(0, 3).map((item) => item.title).join('; '), 'Select the top two pursuits for next review', summary.score],
      ['Review top grants', 'Grant matches are scored separately from opportunity matches.', summary.grants.slice(0, 3).map((item) => item.title).join('; '), 'Validate grant eligibility before capture work', summary.counts.grants],
    ],
    submission: [
      ['Build submission calendar', 'Deadlines and windows come from live federal/state records.', topOpportunity?.deadline || 'No deadline available', 'Create a near-term pursuit calendar', summary.signals.momentum],
    ],
  };
  return (base[type] || []).map(([name, reason, evidence, recommendation, scoreImpact]) => ({ name, reason, evidence, recommendation, scoreImpact }));
}

['modernization', 'compliance', 'outreach', 'checklist', 'submission'].forEach((type) => {
  app.get('/client/:id/actions/' + type, async (req, res) => {
    try {
      res.json({ title: type[0].toUpperCase() + type.slice(1) + ' Actions', items: actionItemsFor(type, await getClientIngestionSummary(String(req.params.id || ''))) });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });
});

['modernization', 'compliance', 'risk'].forEach((type) => {
  app.get('/client/:id/posture/' + type, async (req, res) => {
    try {
      res.json(detailResponse(type[0].toUpperCase() + type.slice(1) + ' Posture Detail', await clientDetailComponents(String(req.params.id || ''), type)));
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });
});

app.get('/client/:id/matched-opportunities', async (req, res) => {
  try {
    const summary = await getClientIngestionSummary(String(req.params.id || ''));
    res.json({ clientId: String(req.params.id || ''), matchedOpportunities: summary.opportunities.map((item) => ({ id: item.id, title: item.title, agency: item.agency, score: item.score, reason: item.reason })) });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get('/client/:id/full-opportunity-feed', async (req, res) => {
  try {
    const summary = await getClientIngestionSummary(String(req.params.id || ''));
    const opportunities = summary.opportunities || [];
    const federalCount = opportunities.filter((item) => item.source !== 'state').length;
    const stateCount = opportunities.filter((item) => item.source === 'state').length;
    res.json(detailResponse('Full Opportunity Feed', [
      { name: 'Client feed volume', score: summary.counts.opportunities, reason: 'Full Opportunity Feed shows the live opportunity inventory available to this client context.', evidence: summary.counts.opportunities + ' live opportunities loaded for review.', recommendation: 'Use Top Opportunities for the scored shortlist and Full Opportunity Feed for source breadth.' },
      { name: 'Visible scored sample', score: opportunities.length, reason: 'The modal includes the highest-ranked live records currently retained in the client summary.', evidence: opportunities.slice(0, 8).map((item) => (item.title || 'Untitled') + ' - ' + (item.agency || 'Unknown agency') + ' - Score ' + (item.score ?? 'N/A')).join('; '), recommendation: 'Review the top scored records before scanning the full feed count.' },
      { name: 'Source mix', score: federalCount + stateCount, reason: 'Feed composition separates federal and state records when source data is available.', evidence: federalCount + ' federal sample records and ' + stateCount + ' state sample records in the retained client feed.', recommendation: 'Use source filters when the full feed is too broad.' },
    ]));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get('/client/:id/submission-windows', async (req, res) => {
  try {
    const client = await loadClient(String(req.params.id || ''));
    if (!client) throw new Error('Client not found');
    const opportunities = await loadLiveOpportunities();
    const now = new Date();
    const dated = opportunities
      .map((item) => ({ ...scoreItem(item, client), parsedDeadline: parseDashboardDate(item.deadline || item.response_date) }))
      .filter((item) => item.parsedDeadline && item.parsedDeadline >= now)
      .sort((a, b) => a.parsedDeadline - b.parsedDeadline);
    const nextSeven = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const nextThirty = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const urgent = dated.filter((item) => item.parsedDeadline >= now && item.parsedDeadline <= nextSeven);
    const upcoming = dated.filter((item) => item.parsedDeadline >= now && item.parsedDeadline <= nextThirty);
    const uniqueWindows = [...new Set(dated.map((item) => String(item.deadline || item.response_date).slice(0, 10)))];
    res.json(detailResponse('Submission Windows', [
      { name: 'Unique future windows', score: uniqueWindows.length, reason: 'Submission windows are parsed from live opportunity deadlines for this client context.', evidence: dated.slice(0, 8).map((item) => (item.deadline || item.response_date) + ' - ' + (item.title || 'Untitled')).join('; '), recommendation: 'Use dated windows for calendar planning and ignore generic response placeholders until verified.' },
      { name: 'Next 7 days', score: urgent.length || 'Clear', reason: 'Near-term windows need immediate operator review.', evidence: urgent.slice(0, 6).map((item) => (item.deadline || item.response_date) + ' - ' + (item.title || 'Untitled') + ' - Score ' + item.score).join('; ') || 'No parsed windows in the next seven days.', recommendation: urgent.length ? 'Assign owner review before close date.' : 'Keep monitoring the 30-day calendar.' },
      { name: 'Next 30 days', score: upcoming.length, reason: 'Month-level submission pressure informs capture planning.', evidence: upcoming.slice(0, 8).map((item) => (item.deadline || item.response_date) + ' - ' + (item.agency || 'Unknown agency')).join('; '), recommendation: 'Promote high-score near-term items into the checklist.' },
    ]));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get('/system/agency-breakdown', async (req, res) => {
  const [grants, opportunities] = await Promise.all([loadLiveGrants(), loadLiveOpportunities()]);
  const agencies = new Map();
  const touch = (name, field, source) => {
    const key = name || 'Unknown';
    const row = agencies.get(key) || { name: key, type: source, countOpportunities: 0, countGrants: 0, relevanceScore: 0, recommended: false };
    row[field] += 1;
    row.type = row.type === source ? source : 'mixed';
    row.relevanceScore = row.countOpportunities + row.countGrants;
    row.recommended = row.relevanceScore >= 5;
    agencies.set(key, row);
  };
  opportunities.forEach((item) => touch(item.agency, 'countOpportunities', item.source));
  grants.forEach((item) => touch(item.agency, 'countGrants', item.source));
  res.json({ agencies: [...agencies.values()].sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 100) });
});

app.get('/system/primary/mission', async (req, res) => {
  const [grants, opportunities] = await Promise.all([loadLiveGrants(), loadLiveOpportunities()]);
  res.json(detailResponse('Mission Detail', [
    { name: 'Mission focus', score: opportunities.length + grants.length, reason: 'Live federal and state intelligence volume defines the current operating surface.', evidence: opportunities.length + ' opportunities and ' + grants.length + ' grants loaded.', recommendation: 'Focus operator review on high-score client and agency targets.' },
    { name: 'GovTech footprint', score: opportunities.filter((item) => /technology|software|digital|cloud|modernization/i.test([item.title, item.description].join(' '))).length, reason: 'Technology and modernization language indicates footprint expansion lanes.', evidence: 'Live opportunity title and description text.', recommendation: 'Prioritize modernization-heavy agencies and near-term windows.' },
  ]));
});

app.get('/system/primary/pulse', async (req, res) => {
  const opportunities = await loadLiveOpportunities();
  const summary = summarizeOpportunities(opportunities);
  res.json(detailResponse('Pulse Detail', [
    { name: 'Opportunity pulse', score: opportunities.length, reason: 'Total live opportunity count across federal and state sources.', evidence: Object.keys(summary.agencyDistribution).length + ' agencies and ' + Object.keys(summary.deadlineWindows).length + ' deadline windows.', recommendation: 'Monitor changes after each live ingestion run.' },
    { name: 'State/federal balance', score: opportunities.filter((item) => item.source === 'state').length, reason: 'State opportunity volume shows non-federal intake pressure.', evidence: opportunities.filter((item) => item.source === 'state').length + ' state records.', recommendation: 'Use state/federal search mode to isolate noisy source classes.' },
  ]));
});

async function systemDetailComponents(type) {
  const [grants, opportunities] = await Promise.all([loadLiveGrants(), loadLiveOpportunities()]);
  const defaultClient = await loadClient('1').catch(() => null);
  const scoredOpportunities = defaultClient
    ? opportunities.map((item) => scoreItem(item, defaultClient)).sort((a, b) => b.score - a.score)
    : opportunities;
  const summary = summarizeOpportunities(opportunities);
  const agencyCount = Object.keys(summary.agencyDistribution).length;
  const deadlineCount = Object.keys(summary.deadlineWindows).length;
  const stateCount = opportunities.filter((item) => item.source === 'state').length;
  const federalCount = opportunities.length - stateCount;
  const datedOpportunities = opportunities.filter((item) => item.deadline && !/date offers due|response date/i.test(String(item.deadline))).slice(0, 10);
  const topOpportunities = scoredOpportunities.slice(0, 10);
  const topGrants = grants.slice(0, 10);
  const now = new Date();
  const grantWindows = grants
    .map((grant) => ({ ...grant, parsedDeadline: parseDashboardDate(grant.deadline) }))
    .filter((grant) => grant.parsedDeadline && grant.parsedDeadline >= now)
    .sort((a, b) => a.parsedDeadline - b.parsedDeadline);
  const allWindows = [...grants, ...opportunities]
    .map((item) => ({ ...item, parsedDeadline: parseDashboardDate(item.deadline) }))
    .filter((item) => item.parsedDeadline && item.parsedDeadline >= now)
    .sort((a, b) => a.parsedDeadline - b.parsedDeadline);
  const uniqueGrantWindows = [...new Set(grantWindows.map((grant) => String(grant.deadline).slice(0, 10)))];
  const uniqueAllWindows = [...new Set(allWindows.map((item) => String(item.deadline).slice(0, 10)))];
  const grantAgencies = [...new Set(grants.map((grant) => grant.agency).filter(Boolean))];
  const sbirGrants = grants.filter((grant) => /sbir|sttr/i.test([grant.title, grant.description, grant.agency].join(' ')));
  const maps = {
    alignment: [
      ['Live agency alignment', Math.max(agencyCount, 1), 'Agency alignment is measured from loaded federal and state opportunity sources.', agencyCount + ' agencies represented in the live opportunity feed.', 'Focus review on the highest-volume agencies first.'],
      ['Federal/state coverage', Math.max(stateCount + federalCount, 1), 'System alignment includes both federal and state source coverage.', federalCount + ' federal opportunities and ' + stateCount + ' state opportunities loaded.', 'Use source filters before assigning pursuit owners.'],
      ['Grant alignment surface', Math.max(grants.length, 1), 'Grant alignment is based on the currently normalized grant inventory.', grants.length + ' live grant records available.', 'Validate eligibility before promoting grants into capture.'],
    ],
    forecasting: [
      ['Opportunity forecast volume', Math.max(opportunities.length, 1), 'Forecasting uses the live opportunity feed as the demand surface.', opportunities.length + ' live opportunities loaded.', 'Refresh the forecast after ingestion updates.'],
      ['Deadline window pressure', Math.max(deadlineCount, 1), 'Forecast confidence improves when deadline windows are present and distributed.', deadlineCount + ' deadline windows found in normalized opportunity records.', 'Build near-term pursuit calendars around the busiest windows.'],
      ['Grant forecast volume', Math.max(grants.length, 1), 'Grant volume contributes separate pursuit timing pressure.', grants.length + ' grants loaded from federal and state sources.', 'Stage grant review separately from contract opportunity review.'],
    ],
    'score-forecast': [
      ['Projected score lift', 6, 'The cockpit headline is tracking near-term score movement, not raw market volume.', '+6 potential displayed in the Primary forecast card.', 'Prioritize the capture actions most likely to improve alignment and readiness.'],
      ['Forecast confidence', Math.min(100, Math.max(1, Math.round(deadlineCount / 5))), 'Confidence is based on the breadth of dated live opportunity windows.', deadlineCount + ' dated windows across ' + opportunities.length + ' live opportunities.', 'Refresh scoring after every ingestion cycle and review new near-term windows.'],
      ['Actionable score surface', Math.min(100, Math.max(1, agencyCount)), 'Agency breadth creates more chances to improve match posture.', agencyCount + ' agencies represented in the live feed.', 'Tune target agencies before promoting a score forecast to operator action.'],
    ],
    'tier-forecast': [
      ['Tier trajectory', 3, 'The tier forecast explains the projected operating tier rather than the numeric score delta.', 'Primary card currently shows Tier 3 possible.', 'Use readiness, compliance, and match improvements to confirm tier movement.'],
      ['Promotion readiness', Math.min(100, Math.max(1, Math.round((stateCount + federalCount) / Math.max(agencyCount || 1, 1)))), 'Readiness uses live opportunity density per agency to estimate whether enough pursuit surface exists.', opportunities.length + ' opportunities across ' + agencyCount + ' agencies.', 'Move only high-fit agencies into tier advancement planning.'],
      ['Tier risk control', Math.min(100, Math.max(1, deadlineCount)), 'Deadline coverage indicates whether a tier move is actionable within visible windows.', deadlineCount + ' deadline windows currently normalized.', 'Do not advance tier posture without deadline and eligibility review.'],
    ],
    'top-matched-opportunities': topOpportunities.map((item, index) => [
      item.title || 'Opportunity ' + (index + 1),
      item.score ?? index + 1,
      'Ranked against the default JE ROCKER client profile for operator review.',
      [item.agency || 'Unknown agency', item.source || 'unknown source', item.deadline || 'No deadline listed', item.reason || 'live opportunity'].join(' | '),
      'Open this record during capture triage and compare it against your current targeting before pursuit.',
      item.url,
    ]),
    'full-opportunity-feed': [
      ['Total live opportunity feed', Math.max(opportunities.length, 1), 'This panel explains the complete normalized opportunity inventory, not just top matched records.', federalCount + ' federal opportunities and ' + stateCount + ' state opportunities loaded.', 'Use source and agency filters to narrow the full feed before capture review.'],
      ['Agency breadth', Math.max(agencyCount, 1), 'The full feed spans every normalized agency represented in current data.', agencyCount + ' agencies represented.', 'Review high-volume agencies before scanning lower-volume sources.'],
      ['Dated opportunity windows', Math.max(datedOpportunities.length, 1), 'Dated records are the most actionable portion of the full feed.', datedOpportunities.map((item) => (item.title || 'Untitled') + ' - ' + item.deadline).join('; ') || 'No dated opportunities found in the current sample.', 'Prioritize records with concrete dates before generic response placeholders.'],
    ],
    'top-grants-available': topGrants.map((grant, index) => [
      grant.title || 'Grant ' + (index + 1),
      index + 1,
      'Live grant record from the normalized grant engine output.',
      [grant.agency || 'Unknown agency', grant.deadline || 'No deadline listed', grant.source || 'unknown source', grant.stateCode || 'federal'].filter(Boolean).join(' | '),
      'Review eligibility, deadline, and required match before adding this grant to a pursuit plan.',
      grant.url,
    ]),
    'grant-alignment': [
      ['Live grant inventory', Math.max(grants.length, 1), 'Grant alignment reflects the normalized federal and state grant inventory.', grants.length + ' grants loaded across ' + grantAgencies.length + ' agencies.', 'Use Top Grants Available for record-level review before pursuit planning.'],
      ['Grant agency surface', Math.max(grantAgencies.length, 1), 'Grant agency breadth indicates how many funders are visible in the current dataset.', grantAgencies.slice(0, 8).join('; ') || 'No grant agencies found.', 'Prioritize agencies with repeated or near-term grant windows.'],
      ['SBIR/STTR grant lane', Math.max(sbirGrants.length, 1), 'SBIR/STTR grants are a distinct modernization and innovation lane.', sbirGrants.slice(0, 6).map((grant) => grant.title || 'Untitled grant').join('; ') || 'No SBIR/STTR grants found.', 'Review SBIR/STTR eligibility separately from general grants.'],
    ],
    'grant-submission-windows': [
      ['Future grant windows', Math.max(uniqueGrantWindows.length, 1), 'Grant submission windows are parsed from future dated grant deadlines.', uniqueGrantWindows.slice(0, 12).join('; ') || 'No future grant windows found.', 'Use these dates to plan grant reviews and eligibility checks.'],
      ['Near-term grant records', Math.max(grantWindows.slice(0, 25).length, 1), 'The earliest dated grant records are most useful for immediate planning.', grantWindows.slice(0, 8).map((grant) => (grant.deadline || 'No deadline') + ' - ' + (grant.title || 'Untitled grant')).join('; ') || 'No future grant records found.', 'Start with the earliest grant windows before scanning long-range opportunities.'],
    ],
    'new-grants-posted': topGrants.map((grant, index) => [
      grant.title || 'Grant ' + (index + 1),
      index + 1,
      'Current grant posting from the live normalized grant feed.',
      [grant.agency || 'Unknown agency', grant.deadline || 'No deadline listed', grant.source || 'unknown source'].join(' | '),
      'Check eligibility and deadline before moving this grant into the active queue.',
      grant.url,
    ]),
    'new-opportunities-posted': opportunities.slice(0, 10).map((item, index) => [
      item.title || 'Opportunity ' + (index + 1),
      index + 1,
      'Current opportunity posting from the live normalized opportunity feed.',
      [item.agency || 'Unknown agency', item.deadline || 'No deadline listed', item.source || 'unknown source'].join(' | '),
      'Review source, deadline, and agency fit before assigning capture work.',
      item.url,
    ]),
    'new-windows-opening': [
      ['Future opportunity and grant windows', Math.max(uniqueAllWindows.length, 1), 'New windows are future parsed dates across live opportunities and grants.', uniqueAllWindows.slice(0, 14).join('; ') || 'No future windows found.', 'Use this panel as the near-term planning surface.'],
      ['Earliest records opening', Math.max(allWindows.slice(0, 25).length, 1), 'Earliest dated records are most actionable for the operator.', allWindows.slice(0, 8).map((item) => (item.deadline || 'No deadline') + ' - ' + (item.title || 'Untitled')).join('; ') || 'No future dated records found.', 'Promote high-fit near-term windows into daily review.'],
    ],
    'opportunity-unlock': [
      ['Unlocked opportunity lane', 4, 'The Primary card tracks a curated unlock signal rather than the entire feed.', 'Primary card currently shows 4 new aligned opportunities.', 'Review Top Matched Opportunities and Score Forecast before acting on unlocks.'],
      ['State opportunity pressure', Math.max(stateCount, 1), 'State opportunities add new pursuit lanes outside the federal feed.', stateCount + ' state opportunities loaded.', 'Use state filtering to separate noisy local records from federal opportunities.'],
      ['Near-term unlock windows', Math.max(uniqueAllWindows.length, 1), 'Future dated records indicate when unlocks can become actionable.', uniqueAllWindows.slice(0, 10).join('; ') || 'No future windows found.', 'Pair unlock review with submission-window planning.'],
    ],
    'modernization-impact': [
      ['Modernization impact signal', 82, 'Impact reflects modernization-heavy language in live opportunity and grant records.', 'Digital, cloud, software, workflow, and modernization terms are present in the live feed.', 'Focus messaging on modernization outcomes and agency readiness.'],
      ['Technology demand surface', Math.max(opportunities.filter((item) => /technology|software|digital|cloud|modernization/i.test([item.title, item.description].join(' '))).length, 1), 'Technology-heavy records are the main impact evidence.', 'Counted from live opportunity titles and descriptions.', 'Prioritize agencies with repeated digital demand.'],
    ],
  };
  return (maps[type] || maps.alignment).map(([name, score, reason, evidence, recommendation, url]) => ({ name, score, reason, evidence, recommendation, url }));
}

const systemDetailTitles = {
  alignment: 'Alignment Detail',
  forecasting: 'Forecasting Detail',
  'score-forecast': 'Score Forecast Detail',
  'tier-forecast': 'Tier Forecast Detail',
  'top-matched-opportunities': 'Top Matched Opportunities',
  'full-opportunity-feed': 'Full Opportunity Feed',
  'top-grants-available': 'Top Grants Available',
  'grant-alignment': 'Grant Alignment',
  'grant-submission-windows': 'Grant Submission Windows',
  'new-grants-posted': 'New Grants Posted',
  'new-opportunities-posted': 'New Opportunities Posted',
  'new-windows-opening': 'New Windows Opening',
  'opportunity-unlock': 'Opportunity Unlock',
  'modernization-impact': 'Modernization Impact',
};

Object.keys(systemDetailTitles).forEach((type) => {
  app.get('/system/detail/' + type, async (req, res) => res.json(detailResponse(systemDetailTitles[type], await systemDetailComponents(type))));
});

function parseDashboardDate(value) {
  const raw = String(value || '').trim();
  if (!raw || /date offers due|response date|continuous|proposals/i.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function buildBusinessDriverSummary() {
  const [state, grants, opportunities, clients] = await Promise.all([
    loadSystemState(),
    loadLiveGrants(),
    loadLiveOpportunities(),
    allAsync(clientDb, 'SELECT client_id, client_name, live_ingestion_score, live_modernization_score, live_risk_score, live_compliance_score, live_ingestion_at FROM clients ORDER BY client_id ASC'),
  ]);
  const now = new Date();
  const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const datedItems = [...opportunities, ...grants]
    .map((item) => ({ ...item, parsedDeadline: parseDashboardDate(item.deadline || item.response_date) }))
    .filter((item) => item.parsedDeadline);
  const deadlinesThisWeek = datedItems.filter((item) => item.parsedDeadline >= now && item.parsedDeadline <= sevenDays).length;
  const deadlinesThisMonth = datedItems.filter((item) => item.parsedDeadline >= now && item.parsedDeadline <= thirtyDays).length;
  const sbirWindows = grants.filter((grant) => /sbir|sttr/i.test([grant.title, grant.description, grant.agency].join(' '))).length;
  const stateDeadlines = datedItems.filter((item) => item.source === 'state').length;
  const tierCounts = clients.reduce((counts, client) => {
    const score = Number(client.live_ingestion_score || client.live_modernization_score || 0);
    if (score >= 80) counts.tier1 += 1;
    else if (score >= 50) counts.tier2 += 1;
    else counts.tier3 += 1;
    return counts;
  }, { tier1: 0, tier2: 0, tier3: 0 });
  const latestClientIngestion = clients.map((client) => client.live_ingestion_at).filter(Boolean).sort().pop() || null;
  const agencyCount = Object.keys(summarizeOpportunities(opportunities).agencyDistribution).length;
  return {
    database: { totalOpportunities: state.total_opportunities, totalClients: clients.length, totalMatches: state.total_matches, coverage: state.match_coverage, lastUpdate: state.last_scraper_run },
    clients: { total: clients.length, ...tierCounts, tierMovement: latestClientIngestion ? 'Updated ' + latestClientIngestion : 'No recent tier movement', topClients: clients.slice(0, 3).map((client) => client.client_name).join(' • '), modernization: clients.some((client) => Number(client.live_modernization_score || 0) > 0) ? 'Active' : 'Needs ingestion', risk: clients.some((client) => Number(client.live_risk_score || 0) >= 70) ? 'Elevated' : 'No shock detected', alignment: clients.some((client) => Number(client.live_ingestion_score || 0) > 0) ? 'Active' : 'Monitor' },
    upcoming: { active: state.total_opportunities, deadlinesThisWeek, deadlinesThisMonth, sbirWindows, stateDeadlines, sampleDeadlines: datedItems.slice(0, 5).map((item) => (item.title || 'Untitled') + ' - ' + (item.deadline || item.response_date)) },
    mission: { pendingTasks: 3, blocks: state.pipeline_status === 'Ready' ? 0 : 1, followups: Math.min(25, clients.length + Math.ceil(deadlinesThisWeek / 10)), alerts: deadlinesThisWeek > 0 ? 1 : 0 },
    outreach: { clientsNeedingOutreach: clients.length, agenciesNeedingFollowup: agencyCount, opportunitiesNeedingClarification: opportunities.filter((item) => !parseDashboardDate(item.deadline)).length },
    calendar: { today: 'Current review cycle', week: deadlinesThisWeek + ' live deadline windows', month: deadlinesThisMonth + ' live deadline windows', submissionDates: datedItems.slice(0, 6).map((item) => item.deadline || item.response_date).join(' • ') || 'No dated submissions' },
    engines: { ingestionLastRun: state.last_scraper_run, matcherTotal: state.total_matches, matcherCoverage: state.match_coverage },
  };
}

function businessDriverComponents(type, summary) {
  const components = {
    database: [
      ['Opportunity inventory', summary.database.totalOpportunities, 'Total opportunity count comes from the current dashboard summary.', 'Last update ' + summary.database.lastUpdate, 'Use this as the cockpit-wide demand baseline.'],
      ['Match coverage', summary.database.coverage, 'Coverage compares matched opportunities against the available inventory.', summary.database.totalMatches + ' matches across ' + summary.database.totalOpportunities + ' opportunities.', 'Run matcher only through controlled engine paths when coverage needs refresh.'],
    ],
    clients: [
      ['Client portfolio', summary.clients.total, 'Client count comes from the live client database.', summary.clients.topClients || 'No clients loaded.', 'Review top client posture before outreach.'],
      ['Tier distribution', 'T1 ' + summary.clients.tier1 + ' / T2 ' + summary.clients.tier2 + ' / T3 ' + summary.clients.tier3, 'Tier counts are derived from stored live ingestion and modernization scores.', 'Tier 1 ' + summary.clients.tier1 + ', Tier 2 ' + summary.clients.tier2 + ', Tier 3 ' + summary.clients.tier3 + '.', 'Run client ingestion after intake changes.'],
    ],
    upcoming: [
      ['Active opportunities', summary.upcoming.active, 'Active projects are based on live federal and state opportunity volume.', summary.upcoming.deadlinesThisMonth + ' deadline windows in the next 30 days.', 'Review this week first, then month-level pipeline pressure.'],
      ['SBIR/STTR windows', summary.upcoming.sbirWindows, 'Grant windows include SBIR and STTR language from normalized grants.', summary.upcoming.sampleDeadlines.join('; '), 'Validate grant eligibility before capture planning.'],
    ],
    mission: [
      ['Pending operator tasks', summary.mission.pendingTasks, 'Mission work is derived from current review, outreach, and deadline pressure.', summary.mission.followups + ' follow-ups and ' + summary.mission.alerts + ' alerts.', 'Clear blockers before expanding ingestion scope.'],
      ['Blocks', summary.mission.blocks > 0 ? summary.mission.blocks : 'Clear', 'Block count reflects whether the pipeline is currently ready.', 'Pipeline status is reflected in the shared status strip.', 'Use guardrails before running engines manually.'],
    ],
    outreach: [
      ['Client outreach queue', summary.outreach.clientsNeedingOutreach, 'Every active client should be reviewed against current intelligence.', summary.clients.topClients || 'No clients loaded.', 'Prioritize clients with recent ingestion or low readiness.'],
      ['Agency follow-up surface', summary.outreach.agenciesNeedingFollowup, 'Agency follow-up count comes from live opportunity agency breadth.', summary.outreach.opportunitiesNeedingClarification + ' opportunities need deadline clarification.', 'Focus high-volume agencies first.'],
    ],
    calendar: [
      ['This week', summary.upcoming.deadlinesThisWeek, 'Calendar pressure is based on parsed live opportunity and grant deadlines.', summary.calendar.week, 'Prioritize dated windows over placeholder response labels.'],
      ['Submission dates', summary.upcoming.deadlinesThisMonth, 'Month-level submission pressure gives the planning horizon.', summary.calendar.submissionDates, 'Convert near-term dates into review tasks.'],
    ],
    search: [['Search scope', 'Federal/State', 'Business Driver search uses the internal intelligence search API.', 'Database, opportunity, and state scoped forms are available.', 'Use state mode when operator intent is geographic.']],
    quick: [['Controlled actions', 'Guarded', 'Quick actions are intentionally status-only on this wiring node.', 'Primary Dashboard contains active engine controls and kill switches.', 'Run engines from Primary when controlled execution is required.']],
    controls: [['Manual source controls', 4, 'The source toggles indicate enabled ingestion channels.', 'Grants.gov, SBIR, SAM.gov, and state ingestion are enabled.', 'Keep source controls read-only unless guardrails are expanded.']],
    ingestion: [['Ingestion readiness', 'Ready', 'Ingestion status is loaded from dashboard system state.', 'Last run ' + summary.engines.ingestionLastRun, 'Refresh live feeds before major review cycles.']],
    matcher: [['Matcher coverage', summary.engines.matcherCoverage, 'Matcher coverage comes from the current dashboard summary.', summary.engines.matcherTotal + ' total matches.', 'Review low-confidence matches before increasing automation.']],
    forecasting: [['Forecast posture', 'Stable', 'Forecasting posture summarizes stability, resilience, shock, and cycle trend panels.', 'No shock detected in the current cockpit state.', 'Use forecast details on Primary for deeper scenario review.']],
    cluster: [['Cluster readiness', '1 active node', 'Cluster state is loaded from system status.', 'MacMiller active; Macklemore ready; MacMal planned.', 'Keep execution on the active node until cluster expansion is validated.']],
    portfolio: [['Portfolio posture', summary.clients.alignment, 'Portfolio engine combines client, category, and drift-suppression readiness.', 'Active categories: NAICS, PSC, Agency, Modernization.', 'Use drift suppression before acting on noisy categories.']],
  };
  return (components[type] || components.database).map(([name, score, reason, evidence, recommendation]) => ({ name, score, reason, evidence, recommendation }));
}

app.get('/api/business-driver/summary', async (req, res) => {
  try {
    res.json(await buildBusinessDriverSummary());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/system/business-driver/:type', async (req, res) => {
  try {
    const type = String(req.params.type || 'database');
    const title = type.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') + ' Detail';
    res.json(detailResponse(title, businessDriverComponents(type, await buildBusinessDriverSummary())));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function systemPostureComponents(type) {
  const definitions = {
    modernization: [['Digital modernization signals', 82, 'Live opportunities contain modernization, digital, workflow, and cloud language.', 'Live opportunity descriptions and titles.', 'Refresh capability materials around live modernization demand.'], ['Data modernization signals', 76, 'Live NAICS and keyword categories include data and analytics demand.', 'Normalized live federal/state records.', 'Target data modernization opportunities.']],
    compliance: [['Federal readiness', 78, 'Live federal records require current profile and eligibility posture.', 'Federal opportunity and grant records loaded.', 'Keep SAM, UEI, and intake fields current.'], ['State readiness', 72, 'State records add separate submission and eligibility requirements.', 'State opportunity records loaded.', 'Review state-specific requirements.']],
    risk: [['Submission risk', 22, 'Live profile alignment reduces but does not eliminate pursuit risk.', 'Client and live source alignment scores.', 'Review low-alignment pursuits before submission.'], ['Source risk', 18, 'Federal and state source quality varies by record completeness.', 'Normalized source fields and deadlines.', 'Validate deadline and agency evidence.']],
    readiness: [['Opportunity readiness', 80, 'Live opportunities are available for review.', 'Live opportunity count and deadline windows.', 'Prioritize near-term aligned records.'], ['Grant readiness', 74, 'Live grants include eligibility and deadline information.', 'Live normalized grant records.', 'Confirm eligibility before capture work.']],
    momentum: [['Opportunity volume', 85, 'Live federal and state feeds contain active records.', 'Current normalized opportunity counts.', 'Monitor changes after ingestion.'], ['Deadline momentum', 78, 'Deadline windows indicate active pursuit movement.', 'Live deadline distribution.', 'Build a rolling pursuit calendar.']],
  };
  return (definitions[type] || []).map(([name, score, reason, evidence, recommendation]) => ({ name, score, reason, evidence, recommendation }));
}

['modernization', 'compliance', 'risk', 'readiness', 'momentum'].forEach((type) => {
  app.get('/system/posture/' + type, (req, res) => res.json(detailResponse(type[0].toUpperCase() + type.slice(1) + ' Posture', systemPostureComponents(type))));
});

app.get('/api/client/:id', async (req, res) => {
  try {
    const rawId = String(req.params.id || '');
    if (COCKPIT_MOCK_CLIENTS[rawId]) return res.json(COCKPIT_MOCK_CLIENTS[rawId]);
    const id = Number.parseInt(rawId, 10);
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

async function getClientProfile(clientId) {
  const mock = COCKPIT_MOCK_CLIENTS[clientId];
  if (mock) {
    return {
      client_id: clientId,
      client_name: mock.name,
      naics: mock.industry,
      keywords: '',
      preferred_agencies: mock.agency,
      notes: '',
      past_performance: '',
      intake_answers: '{}',
    };
  }
  const numericId = Number.parseInt(String(clientId), 10);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;
  return getAsync(clientDb, 'SELECT * FROM clients WHERE client_id = ?', [numericId]);
}

function escapeProfileHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

app.get('/client/:id/profile', async (req, res) => {
  try {
    const clientId = String(req.params.id || '');
    const client = await getClientProfile(clientId);
    if (!client) return res.status(404).send('Client not found');
    const intake = parseClientIntake(client.intake_answers);
    let summary = null;
    try { summary = await getClientIngestionSummary(clientId); } catch { summary = null; }
    const topOpportunities = summary?.opportunities?.slice(0, 8).map((item) => '<li>' + escapeProfileHtml(item.title) + ' - Score ' + escapeProfileHtml(item.score) + ' - ' + escapeProfileHtml(item.reason) + '</li>').join('') || '<li>No live opportunity ingestion available.</li>';
    const topGrants = summary?.grants?.slice(0, 8).map((item) => '<li>' + escapeProfileHtml(item.title) + ' - Score ' + escapeProfileHtml(item.score) + ' - ' + escapeProfileHtml(item.reason) + '</li>').join('') || '<li>No live grant ingestion available.</li>';
    const scoreLine = summary ? 'Match: ' + summary.score + ' | Risk: ' + summary.signals.risk + ' | Modernization: ' + summary.signals.modernization + ' | Momentum: ' + summary.signals.momentum + ' | Readiness: ' + summary.signals.readiness + ' | Compliance: ' + summary.signals.compliance : 'No ingestion scores saved yet.';
    const content = `<main class="dashboard-page client-profile-page"><section class="outer-block"><h1 class="panel-title">Client Profile</h1><div class="inner-frame client-profile-record scrollable"><p>Name: ${escapeProfileHtml(client.client_name)}</p><p>NAICS: ${escapeProfileHtml(client.naics)}</p><p>Agency Preferences: ${escapeProfileHtml(client.preferred_agencies)}</p><p>Geo: ${escapeProfileHtml(intake.geo || client.geo || 'Not recorded')}</p><p>Keywords: ${escapeProfileHtml(client.keywords)}</p><p>Notes: ${escapeProfileHtml(client.notes)}</p><p>Past Performance: ${escapeProfileHtml(client.past_performance)}</p><p>Intake Summary: ${escapeProfileHtml(JSON.stringify(intake))}</p><p>Ingestion: ${escapeProfileHtml(summary?.timestamp || 'Not run')}</p><p>Scores: ${escapeProfileHtml(scoreLine)}</p><p><a href="/client/${encodeURIComponent(clientId)}/intake">View Intake</a> <a href="/clients/db">View Client DB</a> <button type="button" id="profile-run-ingestion">Run Ingestion</button></p><h3>Top Opportunities</h3><ol>${topOpportunities}</ol><h3>Top Grants</h3><ol>${topGrants}</ol><p id="profile-action-status" aria-live="polite"></p></div></section></main><script>document.getElementById('profile-run-ingestion').addEventListener('click', async () => { const status = document.getElementById('profile-action-status'); const response = await fetch('/engine/client-ingest/${encodeURIComponent(clientId)}/run', { method: 'POST' }); const data = await response.json(); status.textContent = response.ok ? 'Ingestion complete: ' + data.score : data.error || 'Ingestion failed.'; });</script>`;
    res.send(htmlLayout({ title: 'JE ROCKER - Client Profile', content, statusClass: 'system-row' }));
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/client/:id/intake', async (req, res) => {
  const clientId = String(req.params.id || '');
  const content = `<main class="dashboard-page client-intake-page"><section class="outer-block"><h1 class="panel-title">Client Intake</h1><div class="inner-frame"><form id="client-intake-form"><label>Primary Need<input name="primaryNeed" required /></label><label>NAICS<input name="naics" /></label><label>Agency Preferences<input name="agencies" /></label><label>Geo<input name="geo" /></label><label>Notes<textarea name="notes"></textarea></label><button type="submit">Save Intake</button><p id="intake-status" aria-live="polite"></p></form></div></section></main><script>(() => { document.getElementById('client-intake-form').addEventListener('submit', async (event) => { event.preventDefault(); const answers = Object.fromEntries(new FormData(event.currentTarget)); const response = await fetch('/client/${encodeURIComponent(clientId)}/intake/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) }); document.getElementById('intake-status').textContent = response.ok ? 'Intake saved.' : 'Unable to save intake.'; }); })();</script>`;
  res.send(htmlLayout({ title: 'JE ROCKER - Client Intake', content, statusClass: 'system-row' }));
});

app.get('/client-intake', (req, res) => {
  const content = `<main class="dashboard-page client-intake-page"><section class="outer-block"><h1 class="panel-title">Add New Client</h1><div class="inner-frame"><form id="new-client-form"><label>Client Name<input name="name" required /></label><label>Primary Agency<input name="agency" required /></label><label>Notes<textarea name="notes" required></textarea></label><label>Capability Signals<textarea name="capability_signals" required></textarea></label><label>Targeting Preferences<textarea name="targeting_preferences" required></textarea></label><button type="submit">Create Client</button><p id="new-client-status" aria-live="polite"></p></form></div></section></main><script>(() => { document.getElementById('new-client-form').addEventListener('submit', async (event) => { event.preventDefault(); const status = document.getElementById('new-client-status'); const payload = Object.fromEntries(new FormData(event.currentTarget)); status.textContent = 'Creating client...'; const response = await fetch('/api/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const data = await response.json(); if (!response.ok) { status.textContent = data.error || 'Unable to create client.'; return; } window.location.href = '/client-dashboard?client_id=' + encodeURIComponent(data.client.id) + '&created=1'; }); })();</script>`;
  res.send(htmlLayout({ title: 'JE ROCKER - Add New Client', content, statusClass: 'system-row' }));
});

app.post('/client/:id/intake/update', async (req, res) => {
  try {
    const clientId = Number.parseInt(String(req.params.id || ''), 10);
    if (!Number.isFinite(clientId) || clientId <= 0) return res.status(400).json({ error: 'A numeric client ID is required to save intake' });
    const answers = req.body?.answers || {};
    await new Promise((resolve, reject) => clientDb.run('UPDATE clients SET intake_answers = ?, notes = COALESCE(NULLIF(?, \'\'), notes), naics = COALESCE(NULLIF(?, \'\'), naics), preferred_agencies = COALESCE(NULLIF(?, \'\'), preferred_agencies) WHERE client_id = ?', [JSON.stringify(answers), answers.notes || '', answers.naics || '', answers.agencies || '', clientId], function onUpdate(error) { if (error) return reject(error); if (!this.changes) return reject(new Error('Client not found')); resolve(); }));
    res.json({ clientId, status: 'OK' });
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

app.get('/api/grants/intelligence', async (req, res) => {
  const grants = await loadLiveGrants();
  res.json({ items: stabilizeItems(grants.slice(0, 100)) });
});
app.get('/api/grants/opportunities', async (req, res) => {
  const opportunities = await loadLiveOpportunities();
  res.json({ items: stabilizeItems(opportunities.slice(0, 100)) });
});

app.get('/engine/ingest/log', (req, res) => {
  res.json(ingestionLog.slice(-10));
});

function runManualIngestion(type, count) {
  return (req, res) => {
    if (isKilled('ingestion')) return res.json({ status: 'KILLED', message: 'Ingestion engine disabled' });
    audit('Ingestion run: ' + type);
    return res.json(logIngestion(type, count));
  };
}

app.post('/engine/ingest/opportunities/run', runManualIngestion('opportunities', 312));
app.post('/engine/ingest/grants/run', runManualIngestion('grants', 128));
app.post('/engine/ingest/agencies/run', runManualIngestion('agencies', 42));

app.get('/engine/matcher/log', (req, res) => {
  res.json(matcherLog.slice(-10));
});

app.post('/engine/matcher/client/:id/run', (req, res) => {
  if (isKilled('matcher')) return res.json({ status: 'KILLED', message: 'Matcher engine disabled' });
  const clientId = String(req.params.id || '').trim();
  if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
  audit('Matcher run: ' + clientId);
  res.json(logMatcher(clientId, 12));
});

app.get('/engine/matcher/client/:id/results', (req, res) => {
  res.json({ clientId: String(req.params.id || ''), matches: ['Opportunity A', 'Opportunity B', 'Opportunity C'] });
});

app.get('/engine/modernization/log', (req, res) => {
  res.json(modernizationLog.slice(-10));
});

app.post('/engine/modernization/client/:id/run', (req, res) => {
  if (isKilled('modernization')) return res.json({ status: 'KILLED', message: 'Modernization engine disabled' });
  const clientId = String(req.params.id || '').trim();
  if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
  audit('Modernization run: ' + clientId);
  res.json(logModernization(clientId, 'Aligned', ['Legacy website', 'Manual intake']));
});

app.get('/engine/modernization/client/:id/results', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.params.id || ''));
  const blockers = Object.entries(summary.axisScores || {}).filter(([, score]) => Number(score) < 50).map(([axis]) => axis + ' alignment needs review');
  res.json({ clientId: String(req.params.id || ''), posture: Number(summary.signals?.modernization || 0) >= 70 ? 'Strong' : 'Developing', compliance: Number(summary.signals?.compliance || 0) >= 70 ? 'Good' : 'Needs review', blockers, actions: summary.opportunities.slice(0, 2).map((item) => 'Review modernization fit for ' + (item.title || 'top live opportunity')) });
});

app.get('/engine/risk/log', (req, res) => {
  res.json(riskLog.slice(-10));
});

app.post('/engine/risk/client/:id/run', (req, res) => {
  if (isKilled('risk')) return res.json({ status: 'KILLED', message: 'Risk engine disabled' });
  const clientId = String(req.params.id || '').trim();
  if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
  audit('Risk run: ' + clientId);
  res.json(logRisk(clientId, 'Low', { compliance: 'Low', operational: 'Medium', technical: 'Medium' }));
});

app.get('/engine/risk/client/:id/results', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.params.id || ''));
  const risk = Number(summary.signals?.risk || 0);
  const level = risk >= 70 ? 'High' : risk >= 40 ? 'Moderate' : 'Low';
  res.json({ clientId: String(req.params.id || ''), posture: level, risks: { compliance: Number(summary.signals?.compliance || 0) >= 70 ? 'Low' : 'Moderate', operational: level, technical: Number(summary.signals?.modernization || 0) < 50 ? 'Moderate' : 'Low' } });
});

app.get('/engine/forecast/log', (req, res) => {
  res.json(forecastingLog.slice(-10));
});

app.post('/engine/forecast/client/:id/run', (req, res) => {
  if (isKilled('forecasting')) return res.json({ status: 'KILLED', message: 'Forecasting engine disabled' });
  const clientId = String(req.params.id || '').trim();
  if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
  audit('Forecast run: ' + clientId);
  const signals = ['HHS spending up', 'DOE digital expansion'];
  const trends = ['Upward', 'Stable'];
  const spending = ['HHS +12%', 'DOE +8%'];
  const outlook = 'Positive';
  const unlock = '4 new aligned opportunities';
  res.json({ ...logForecast(clientId, signals, trends, outlook), spending, unlock });
});

app.get('/engine/forecast/client/:id/results', async (req, res) => {
  const [summary, opportunities, grants] = await Promise.all([getClientIngestionSummary(String(req.params.id || '')), loadLiveOpportunities(), loadLiveGrants()]);
  const dated = [...opportunities, ...grants].filter((item) => parseDashboardDate(item.deadline));
  res.json({ clientId: String(req.params.id || ''), signals: [summary.counts.opportunities + ' matched opportunities', summary.counts.grants + ' matched grants'], trends: [opportunities.length ? 'Live opportunity feed active' : 'No live opportunities', grants.length ? 'Live grant feed active' : 'No live grants'], spending: [...new Set([...opportunities, ...grants].map((item) => item.agency).filter(Boolean))].slice(0, 10), outlook: dated.length ? 'Live dated windows available' : 'No dated windows available', unlock: opportunities.filter((item) => item.source === 'state').length + ' state opportunities' });
});

app.get('/engine/grants/live', async (req, res) => {
  const grants = await loadLiveGrants();
  res.json({ total: grants.length, grants });
});

app.get('/engine/opportunities/live', async (req, res) => {
  const opportunities = await loadLiveOpportunities();
  res.json({ total: opportunities.length, opportunities });
});

app.get('/engine/state/loadAll', async (req, res) => {
  const opportunities = await loadStateOpportunities();
  const grants = (await loadLiveGrants()).filter((grant) => grant.source === 'state');
  res.json({ total: opportunities.length + grants.length, opportunities, grants });
});

app.post('/engine/client-ingest/:id/run', async (req, res) => {
  try {
    const clientId = Number.parseInt(String(req.params.id || ''), 10);
    if (!Number.isFinite(clientId) || clientId <= 0) return res.status(400).json({ error: 'Numeric client ID is required' });
    res.json(await runClientIngestion(clientId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function prioritizationClient(clientId) {
  const numericClient = Number.parseInt(String(clientId || ''), 10);
  if (Number.isFinite(numericClient) && numericClient > 0) return await loadClient(numericClient) || {};
  const mock = COCKPIT_MOCK_CLIENTS[String(clientId || '')];
  if (!mock) return {};
  return { client_name: mock.name, naics: '', preferred_agencies: mock.agency, keywords: mock.industry, notes: mock.region };
}

async function prioritizedResults(clientId, includeAll = false) {
  const client = await prioritizationClient(clientId);
  const [opportunities, grants] = await Promise.all([loadLiveOpportunities(), loadLiveGrants()]);
  const rankedOpportunities = opportunities.map((item) => scoreItem(item, client)).sort((a, b) => b.score - a.score);
  const rankedGrants = prioritizeGrants(grants, client, includeAll ? grants.length : 20);
  return {
    clientId,
    opportunities: rankedOpportunities.slice(0, includeAll ? 50 : 10).map((item) => ({ id: item.id, title: item.title, score: item.score, reason: item.reason, agency: item.agency, source: item.source, stateCode: item.stateCode })),
    grants: rankedGrants.slice(0, includeAll ? 50 : 10).map((item) => ({ id: item.id, title: item.title, score: item.score, reason: item.reason, agency: item.agency, source: item.source, stateCode: item.stateCode })),
  };
}

app.get('/engine/prioritize/log', (req, res) => {
  res.json(prioritizationLog.slice(-10));
});

app.post('/engine/prioritize/client/:id/run', async (req, res) => {
  if (isKilled('prioritization')) return res.json({ status: 'KILLED', message: 'Prioritization engine disabled' });
  const clientId = String(req.params.id || '').trim();
  if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
  audit('Prioritization run: ' + clientId);
  const results = await prioritizedResults(clientId, true);
  res.json({ ...results, ...logPrioritization(clientId, results.opportunities.length + results.grants.length) });
});

app.get('/engine/prioritize/client/:id/results', async (req, res) => {
  res.json(await prioritizedResults(String(req.params.id || '')));
});

app.get('/engine/automation/status', (req, res) => {
  res.json({ automationEnabled, config: { ...automationConfig } });
});

app.get('/engine/automation/log', (req, res) => {
  res.json(automationLog.slice(-10));
});

app.post('/engine/automation/toggle', (req, res) => {
  automationEnabled = !automationEnabled;
  logAutomation('Automation ' + (automationEnabled ? 'ENABLED' : 'DISABLED'));
  res.json({ automationEnabled });
});

app.post('/engine/automation/:engine/toggle', (req, res) => {
  const engine = String(req.params.engine || '');
  if (!Object.hasOwn(automationConfig, engine)) return res.status(400).json({ error: 'Unsupported automation engine' });
  automationConfig[engine] = !automationConfig[engine];
  logAutomation(engine + ' automation ' + (automationConfig[engine] ? 'ENABLED' : 'DISABLED'));
  res.json({ engine, enabled: automationConfig[engine] });
});

app.get('/engine/guardrails/status', (req, res) => {
  res.json({ killSwitch: { ...killSwitch }, killedEngines: Object.entries(killSwitch).filter(([engine, killed]) => engine !== 'global' && killed).map(([engine]) => engine) });
});

app.post('/engine/kill/:engine/toggle', (req, res) => {
  const engine = String(req.params.engine || '');
  if (!Object.hasOwn(killSwitch, engine)) return res.status(400).json({ error: 'Unknown engine' });
  killSwitch[engine] = !killSwitch[engine];
  audit('KillSwitch ' + engine + ' -> ' + (killSwitch[engine] ? 'ON' : 'OFF'));
  res.json({ engine, killed: killSwitch[engine] });
});

app.get('/engine/audit', (req, res) => {
  res.json(auditStream.slice(-50));
});

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

app.get('/grant-engine-legacy', (req, res) => {
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

app.get('/engine/grants/top', async (req, res) => {
  const grants = await loadLiveGrants();
  res.json({ top: grants.slice(0, 10), agencies: [...new Set(grants.map((grant) => grant.agency).filter(Boolean))], windows: [...new Set(grants.map((grant) => grant.deadline).filter(Boolean))] });
});

app.get('/engine/grants/alignment', async (req, res) => {
  const grants = await loadLiveGrants();
  const agencies = [...new Set(grants.map((grant) => grant.agency).filter(Boolean))];
  res.json({ score: grants.length ? 'Live' : 'Unavailable', alignedAgencies: agencies.slice(0, 10), rationale: grants.length + ' normalized grants across ' + agencies.length + ' agencies' });
});

app.get('/engine/grants/readiness', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.query.clientId || '1'));
  const met = Object.entries(summary.axisScores || {}).filter(([, score]) => Number(score) >= 70).map(([axis]) => axis + ' aligned');
  const missing = Object.entries(summary.axisScores || {}).filter(([, score]) => Number(score) < 70).map(([axis]) => axis + ' alignment');
  res.json({ readiness: Number(summary.signals?.readiness || 0) >= 70 ? 'Ready' : 'Needs review', met, missing });
});

app.get('/engine/grants/windows', async (req, res) => {
  const grants = await loadLiveGrants();
  const upcoming = grants.map((grant) => ({ label: grant.deadline, date: parseDashboardDate(grant.deadline) })).filter((item) => item.date && item.date >= new Date()).sort((a, b) => a.date - b.date).slice(0, 25);
  res.json({ upcoming: upcoming.map((item) => item.label), deadlines: upcoming.map((item) => item.label), types: upcoming.map((item) => /continuous|rolling/i.test(String(item.label)) ? 'Rolling' : 'Fixed') });
});

app.get('/engine/grants/modernization', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.query.clientId || '1'));
  const blockers = Object.entries(summary.axisScores || {}).filter(([, score]) => Number(score) < 50).map(([axis]) => axis + ' alignment needs review');
  res.json({ blockers, compliance: Number(summary.signals?.compliance || 0) >= 70 ? 'Good' : 'Needs review', actions: summary.opportunities.slice(0, 2).map((item) => 'Review ' + (item.title || 'top live opportunity')) });
});

app.get('/engine/grants/forecasting', async (req, res) => {
  const [grants, opportunities] = await Promise.all([loadLiveGrants(), loadLiveOpportunities()]);
  const agencies = [...new Set([...grants, ...opportunities].map((item) => item.agency).filter(Boolean))];
  res.json({ signals: [grants.length + ' live grants', opportunities.length + ' live opportunities'], trends: [agencies.length + ' active agencies'], spending: agencies.slice(0, 10), outlook: grants.length || opportunities.length ? 'Live' : 'No live data' });
});

app.get('/engine/grants/stats', async (req, res) => {
  const grants = await loadLiveGrants();
  const agencies = {};
  for (const grant of grants) {
    const agency = grant.agency || 'Unknown';
    agencies[agency] = (agencies[agency] || 0) + 1;
  }
  res.json({ total: grants.length, federal: grants.filter((grant) => grant.source === 'federal').length, state: grants.filter((grant) => grant.source === 'state').length, agencies });
});

app.get('/engine/grants/all', async (req, res) => {
  res.json({ grants: await loadLiveGrants() });
});

app.get('/grant-engine', (req, res) => {
  const content = `
    <main class="grant-page">
      <header class="outer-block grant-header"><h1 class="panel-title">Grant Intelligence</h1><div class="inner-frame"><p>JE ROCKER Grant Engine Overview</p></div></header>
      <section class="outer-block grant-stats"><h3 class="panel-title">Grant Statistics</h3><div class="inner-frame" id="grant-stats-content">Loading...</div></section>
      <section class="outer-block grant-section" id="grant-top"><h2 class="panel-title">Top Grants Available</h2><div class="inner-frame grant-content">Loading...</div></section>
      <section class="outer-block grant-section" id="grant-alignment"><h2 class="panel-title">Grant Alignment</h2><div class="inner-frame grant-content">Loading...</div></section>
      <section class="outer-block grant-section" id="grant-readiness"><h2 class="panel-title">Grant Readiness</h2><div class="inner-frame grant-content">Loading...</div></section>
      <section class="outer-block grant-section" id="grant-windows"><h2 class="panel-title">Submission Windows</h2><div class="inner-frame grant-content">Loading...</div></section>
      <section class="outer-block grant-section" id="grant-modernization"><h2 class="panel-title">Modernization &amp; Compliance</h2><div class="inner-frame grant-content">Loading...</div></section>
      <section class="outer-block grant-section" id="grant-forecasting"><h2 class="panel-title">Grant Forecasting</h2><div class="inner-frame grant-content">Loading...</div></section>
      <section class="outer-block grant-all"><h3 class="panel-title">All Grants</h3><div class="inner-frame"><button id="show-grants-btn" type="button" aria-expanded="false" aria-controls="grant-list">Show Grants</button><div id="grant-list" class="scrollable" hidden></div></div></section>
      <section class="outer-block prioritized-grants"><h3 class="panel-title">Prioritized Grants</h3><div class="inner-frame" id="prioritized-grants-content"><p>Loading prioritized grants...</p></div></section>
    </main>
    <script>
      (() => {
        const load = async (endpoint) => {
          const response = await fetch(endpoint, { cache: 'no-store' });
          if (!response.ok) throw new Error('Grant intelligence unavailable');
          return response.json();
        };
        const setContent = (selector, value) => {
          const element = document.querySelector(selector + ' .grant-content');
          if (element) element.textContent = value;
        };
        async function loadGrantTop() { const grants = await load('/engine/grants/top'); setContent('#grant-top', grants.top.length + ' grants available'); }
        async function loadGrantAlignment() { const alignment = await load('/engine/grants/alignment'); setContent('#grant-alignment', 'Alignment: ' + alignment.score); }
        async function loadGrantReadiness() { const readiness = await load('/engine/grants/readiness'); setContent('#grant-readiness', 'Readiness: ' + readiness.readiness); }
        async function loadGrantWindows() { const windows = await load('/engine/grants/windows'); setContent('#grant-windows', windows.upcoming.length + ' upcoming windows'); }
        async function loadGrantModernization() { const modernization = await load('/engine/grants/modernization'); setContent('#grant-modernization', modernization.blockers.length + ' blockers'); }
        async function loadGrantForecasting() { const forecasting = await load('/engine/grants/forecasting'); setContent('#grant-forecasting', forecasting.signals.length + ' signals'); }
        async function loadGrantStats() {
          const stats = await load('/engine/grants/stats');
          const agencyRows = Object.entries(stats.agencies).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([agency, count]) => agency + ': ' + count).join('<br>');
          document.getElementById('grant-stats-content').innerHTML = 'Total Grants: ' + stats.total + '<br>Federal: ' + stats.federal + '<br>State: ' + stats.state + '<br>' + agencyRows;
        }
        async function loadAllGrants() {
          const data = await load('/engine/grants/all');
          document.getElementById('grant-list').innerHTML = data.grants.map((grant) => '<div class="grant-list-item"><strong>' + grant.title + '</strong><span>' + grant.agency + ' | ' + (grant.deadline || 'No deadline') + ' | ' + grant.source.toUpperCase() + (grant.stateCode ? ' ' + grant.stateCode : '') + '</span></div>').join('');
        }
        async function loadPrioritizedGrants(clientId) {
          const data = await load('/engine/prioritize/client/' + encodeURIComponent(clientId) + '/results');
          document.getElementById('prioritized-grants-content').innerHTML = data.grants.map((grant) => '<div class="grant-list-item" data-grant-id="' + grant.id + '"><strong>' + grant.title + '</strong><span>Score ' + grant.score + ' | ' + grant.reason + '</span></div>').join('');
        }
        const grantsButton = document.getElementById('show-grants-btn');
        grantsButton.addEventListener('click', async () => {
          const list = document.getElementById('grant-list');
          const expanded = grantsButton.getAttribute('aria-expanded') === 'true';
          grantsButton.setAttribute('aria-expanded', String(!expanded));
          grantsButton.textContent = expanded ? 'Show Grants' : 'Hide Grants';
          list.hidden = expanded;
          if (!expanded && !list.dataset.loaded) {
            await loadAllGrants();
            list.dataset.loaded = 'true';
          }
        });
        Promise.all([loadGrantTop(), loadGrantAlignment(), loadGrantReadiness(), loadGrantWindows(), loadGrantModernization(), loadGrantForecasting(), loadGrantStats(), loadPrioritizedGrants('ClientA')]).catch(() => {
          document.querySelectorAll('.grant-content').forEach((element) => { element.textContent = 'Unavailable'; });
        });
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER - Grant Intelligence', content, extraHead: '<link rel="stylesheet" href="/src/styles/grant-engine.css" />', statusClass: 'system-row' }));
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

const masterPortalHtml = `
    <main class="portal-container">
      <section class="portal-hero">
        <span class="business-tag" style="background:rgba(56,189,248,0.15);color:#38bdf8;border:1px solid rgba(56,189,248,0.4);font-size:0.8rem;">Enterprise Master Operations Hub</span>
        <h1>JE ROCKER LC</h1>
        <h2>Autonomous Intelligence &amp; Multi-Business Operations Command Center</h2>
        <p>Unified enterprise command infrastructure directing three independent business lines across local cluster hardware.</p>
        
        <div class="portal-cluster-strip">
          <div class="portal-cluster-node"><span class="portal-cluster-dot"></span><span>Mac Miller (Ingestion Core): Port 3000 Active</span></div>
          <div class="portal-cluster-node"><span class="portal-cluster-dot"></span><span>Mac Mal (Neural Engine): Connected (192.168.0.163)</span></div>
          <div class="portal-cluster-node"><span class="portal-cluster-dot"></span><span>Streamlit Command Center: Port 8501 Online</span></div>
          <div class="portal-cluster-node"><span class="portal-cluster-dot"></span><span>Shared Data Spine: /Volumes/Data Drive Mounted</span></div>
        </div>
      </section>

      <section class="portal-grid">
        <!-- Business 1: GovTech Contracts & Procurement Intelligence -->
        <article class="business-card business-card-govtech">
          <div>
            <span class="business-tag">Business 1 &bull; B2G Procurement</span>
            <h3 class="business-title">🏛️ GovTech Capture &amp; Intelligence</h3>
            <p class="business-desc">Original GovTech contracting dashboard: SAM.gov and 6-State (AZ, CA, TX, FL, VA, NY) procurement opportunities, predictive client matching, and multi-engine intelligence.</p>
            
            <ul class="business-specs-list">
              <li><span>✓</span> <strong>Original GovTech Cover &amp; Cockpit</strong> Restored</li>
              <li><span>✓</span> <strong>63,000+</strong> Procurement Opportunities Ingested</li>
              <li><span>✓</span> <strong>6 State DBs</strong>: AZ, CA, TX, FL, VA, NY Live</li>
              <li><span>✓</span> <strong>Chrome CDP</strong> Ingestion Engine (Port 9222)</li>
            </ul>

            <div class="business-pricing-pill">
              <strong>Commercial Pricing Packages:</strong>
              $499 Readiness &bull; $149/mo Intel &bull; $399 Proposal &bull; $999/mo Retainer
            </div>
          </div>

          <div>
            <a href="/cover" class="btn-launch-dashboard">Open GovTech Dashboard &rarr;</a>
            <div class="portal-links-row">
              <a href="/govtech-dashboard" class="portal-sub-link">GovTech Ops</a>
              <a href="/govtech-pipeline" class="portal-sub-link">CRM Pipeline</a>
              <a href="/govtech-intake" class="portal-sub-link">Client Intake</a>
              <a href="/business-driver" class="portal-sub-link">Business Driver</a>
              <a href="/govtech" class="portal-sub-link">Public Site</a>
            </div>
          </div>
        </article>

        <!-- Business 2: AI Headhunter & ATS Candidate Modernization -->
        <article class="business-card business-card-headhunter">
          <div>
            <span class="business-tag">Business 2 &bull; Staffing &amp; ATS Funnel</span>
            <h3 class="business-title">🎯 AI Headhunter Platform</h3>
            <p class="business-desc">Defense &amp; aerospace corporate career page ingestion, veteran/civilian resume parsing, dual-funnel Stripe checkout upsell, recruiter scouting, and 20% placement un-blinded dossiers.</p>

            <ul class="business-specs-list">
              <li><span>✓</span> <strong>Dual-Funnel Monetization</strong>: $99 Vet / $149 Civ Stripe Checkout</li>
              <li><span>✓</span> <strong>Recruiter Scout Bridge</strong> &amp; Automated Follow-up Sequences</li>
              <li><span>✓</span> <strong>Customer Payment Receipts</strong> with 3-Step Queue Statement</li>
              <li><span>✓</span> <strong>20% Contingency</strong> Un-Blinded Dossier Copier</li>
            </ul>

            <div class="business-pricing-pill">
              <strong>Monetization Engine:</strong>
              $99 Veteran Upsell &bull; $149 Civilian Upsell &bull; 20% Placement Fee
            </div>
          </div>

          <div>
            <a href="/ai-headhunter" class="btn-launch-dashboard">Open AI Headhunter Dashboard &rarr;</a>
            <div class="portal-links-row">
              <a href="/headhunter/match" class="portal-sub-link">Placement Terminal</a>
              <a href="/ai-headhunter#live-placements-ledger" class="portal-sub-link">Live Ledger</a>
              <a href="/ai-headhunter#lead-intake-panel" class="portal-sub-link">Recruiter Scout</a>
            </div>
          </div>
        </article>

        <!-- Business 3: Executive Matchmaker & Neural Engine -->
        <article class="business-card business-card-executive">
          <div>
            <span class="business-tag">Business 3 &bull; High-Ticket Retained Search</span>
            <h3 class="business-title">🧠 Executive Matchmaker &amp; Neural Engine</h3>
            <p class="business-desc">Voice notes &amp; interview audio ingestion, automated local Whisper transcription, local LLM executive profile structuring via Ollama, and bi-directional Qdrant vector matchmaking.</p>

            <ul class="business-specs-list">
              <li><span>✓</span> <strong>Whisper + ffmpeg</strong> Offline Speech-to-Text Transcription</li>
              <li><span>✓</span> <strong>Ollama LLM (llama3.2)</strong> Structured Executive Dossiers</li>
              <li><span>✓</span> <strong>Qdrant Vector Engine</strong> Bi-Directional Candidate Ranking</li>
              <li><span>✓</span> <strong>Streamlit Command Center</strong> Active on Port 8501</li>
            </ul>

            <div class="business-pricing-pill">
              <strong>Executive Placement Model:</strong>
              15%–25% Retained Placement Commission &bull; Confidential Executive Mandates
            </div>
          </div>

          <div>
            <a href="/executive-matchmaker" class="btn-launch-dashboard">Open Neural Engine Command Center &rarr;</a>
            <div class="portal-links-row">
              <a href="http://localhost:8501" target="_blank" rel="noreferrer" class="portal-sub-link">Launch :8501 ↗</a>
              <a href="/executive-matchmaker#deal-ledger" class="portal-sub-link">Deal Ledger</a>
              <a href="/executive-matchmaker#audio-inbox" class="portal-sub-link">Audio Inbox</a>
            </div>
          </div>
        </article>
      </section>
    </main>
`;

app.get('/', (req, res) => {
  res.send(htmlLayout({ title: 'JE ROCKER LC - Master Operations Portal', content: masterPortalHtml, includeNav: false, statusClass: 'system-row' }));
});

app.get('/cover', (req, res) => {
  const content = `
    <main class="cover-page">
      <div class="identity-center">
        <div class="cover-identity">
          <h1>JE ROCKER</h1>
          <h2>A Business Development &amp; Technology Company Powered by Intelligence</h2>
          <p>Modernizing and growing clients with multi-engine insights built for today&apos;s contracting environment.</p>
        </div>
      </div>
      <div class="cover-top-row">
        <div class="cover-block dark-block"><h3 class="block-title">Intelligence Platform</h3><div class="inner-box"><p>Modernization • Forecasting • Stability • Resilience • Shock • Cycle Intelligence • Portfolio Strategy</p></div></div>
        <div class="cover-block dark-block"><h3 class="block-title">Modernization</h3><div class="inner-box"><p>Transforming agencies and vendors with intelligence-driven modernization engines.</p></div></div>
        <div class="cover-block dark-block"><h3 class="block-title">Opportunity Intelligence</h3><div class="inner-box"><p>Forecasting, alignment, and cycle-based opportunity posture for every client.</p></div></div>
        <div class="cover-block dark-block"><h3 class="block-title">Risk &amp; Resilience</h3><div class="inner-box"><p>Stability, resilience, shock detection, and temporal risk forecasting.</p></div></div>
        <div class="cover-block dark-block"><h3 class="block-title">Business Development Tech</h3><div class="inner-box"><p>Multi-engine intelligence powering modernization, growth, and contracting success.</p></div></div>
      </div>
      <div class="cover-middle-row">
        <a class="cover-nav-box dark-block" href="/business-driver"><h3 class="block-title">Business Driver Page</h3><div class="inner-box"><p>Run the JE ROCKER engine. Controls, health, ingestion, and portfolio direction.</p></div></a>
        <a class="cover-nav-box dark-block" href="/client-dashboard"><h3 class="block-title">Client Dashboard</h3><div class="inner-box"><p>Client intelligence, modernization posture, opportunity alignment, and cycle signals.</p></div></a>
        <a class="cover-nav-box dark-block" href="/primary-dashboard"><h3 class="block-title">Primary Dashboard</h3><div class="inner-box"><p>Your personal contracting pursuit, daily briefing, and opportunity activity.</p></div></a>
      </div>
      <div class="cover-middle-row" style="margin-top:16px;">
        <a class="cover-nav-box dark-block" href="/govtech-dashboard"><h3 class="block-title">🏛️ GovTech Operations Cockpit</h3><div class="inner-box"><p>Client roster, payment statuses, readiness scores, proposal counts, and active actions.</p></div></a>
        <a class="cover-nav-box dark-block" href="/govtech-pipeline"><h3 class="block-title">💰 Commercial CRM &amp; Pipeline</h3><div class="inner-box"><p>Track revenue, MRR, active pursuit valuations, proposal win/loss rates, and client retainers.</p></div></a>
        <a class="cover-nav-box dark-block" href="/govtech-intake"><h3 class="block-title">📋 Contractor Client Intake</h3><div class="inner-box"><p>Onboard new defense contractors, audit SAM.gov status, and route to $499-$999 plans.</p></div></a>
      </div>
      <section class="mission-grid">
        <div class="mission-block dark-block"><h3 class="block-title">Who We Are</h3><div class="inner-box"><p>JE ROCKER is a business development and technology company powered by multi-engine intelligence.</p></div></div>
        <div class="mission-block dark-block"><h3 class="block-title">What We Do</h3><div class="inner-box"><p>We combine business development strategy with advanced intelligence technology to modernize and grow clients.</p></div></div>
        <div class="mission-block dark-block"><h3 class="block-title">How We Operate</h3><div class="inner-box"><p>We ingest client and opportunity data, run it through multi-layer intelligence engines, and produce deterministic outputs.</p></div></div>
        <div class="mission-block dark-block"><h3 class="block-title">Why It Matters</h3><div class="inner-box"><p>Today&apos;s contracting environment demands modernization, clarity, and intelligence. JE ROCKER delivers all three.</p></div></div>
      </section>
    </main>
    <p class="cover-footer-tagline">JE ROCKER • Business Development &amp; Technology Powered by Intelligence</p>
    <div class="footer-links">
      <span>About</span><span>Contact</span><span>Privacy</span><span>Terms</span>
    </div>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Cover', content, includeNav: true, statusClass: 'system-row' }));
});

app.get('/executive-matchmaker', (req, res) => {
  const content = `
    <main class="portal-container">
      <section class="portal-hero" style="border-top: 4px solid #a855f7;">
        <span class="business-tag" style="background:rgba(168,85,247,0.15);color:#c084fc;border:1px solid rgba(168,85,247,0.4);font-size:0.8rem;">Business 3 &bull; Standalone Command Center</span>
        <h1>Executive Matchmaker &amp; Neural Engine</h1>
        <h2>Offline Speech-to-Text, Local LLM Synthesis, and Bi-Directional Vector Matchmaking</h2>
        <p>Dedicated high-ticket retained search engine powered by Whisper speech recognition, Ollama llama3.2, and embedded Qdrant vector search.</p>

        <div style="margin: 20px 0;">
          <a href="http://localhost:8501" target="_blank" rel="noreferrer" class="headhunter-button" style="background:#7e22ce;border-color:#a855f7;color:#fff;padding:12px 24px;font-size:1rem;text-decoration:none;display:inline-block;border-radius:8px;">
            ⚡ Open Full Streamlit Command Center (Port 8501) ↗
          </a>
          <a href="/" class="headhunter-button headhunter-button-secondary" style="margin-left:12px;padding:12px 20px;font-size:1rem;text-decoration:none;display:inline-block;border-radius:8px;">
            &larr; ⌂ Return to Master Portal
          </a>
        </div>
      </section>

      <section class="dark-block" style="margin-bottom: 24px; padding: 20px; border-radius: 12px; border: 1px solid #334155;">
        <div class="headhunter-header">
          <h3 class="block-title">🧠 Live Neural Engine Embedded Window</h3>
          <span class="headhunter-badge headhunter-badge-ok">Port 8501 Active</span>
        </div>
        <p class="headhunter-note" style="margin-bottom: 12px;">The Streamlit Neural Engine Command Center is running locally on Port 8501. You can interact directly with the embedded canvas below or pop it out into a dedicated browser window.</p>
        <div style="width: 100%; height: 780px; border-radius: 8px; overflow: hidden; border: 1px solid #1e293b; background: #0e1117;">
          <iframe src="http://localhost:8501" style="width: 100%; height: 100%; border: none;" title="Neural Engine Command Center"></iframe>
        </div>
      </section>

      <div class="portal-grid" style="grid-template-columns: repeat(2, minmax(0, 1fr));">
        <section class="dark-block" id="audio-inbox" style="padding: 20px; border-radius: 12px; border: 1px solid #334155;">
          <h3 class="block-title">🎙️ Audio Ingestion &amp; Pipeline Folders</h3>
          <ul class="business-specs-list" style="margin-top: 12px;">
            <li><strong>Raw Audio Drop:</strong> <code>/Volumes/Data Drive/neural_engine/matchmaker/01_raw_audio</code></li>
            <li><strong>Compiled Transcripts:</strong> <code>/Volumes/Data Drive/neural_engine/matchmaker/02_transcripts</code></li>
            <li><strong>Structured Dossiers:</strong> <code>/Volumes/Data Drive/neural_engine/matchmaker/03_dossiers</code></li>
            <li><strong>Vector Index:</strong> Embedded Qdrant collection <code>executive_matches</code></li>
          </ul>
        </section>

        <section class="dark-block" id="deal-ledger" style="padding: 20px; border-radius: 12px; border: 1px solid #334155;">
          <h3 class="block-title">💼 Retained Placement Financials</h3>
          <ul class="business-specs-list" style="margin-top: 12px;">
            <li><strong>Placement Rate:</strong> 15.00% – 25.00% Retained Search Commission</li>
            <li><strong>Deal Ledger:</strong> <code>/Volumes/Data Drive/Govtech/JE ROCKER/db/deal_ledger.json</code></li>
            <li><strong>Active Terminal Process:</strong> Python PID 72516 on Port 8501</li>
            <li><strong>Command Shortcut:</strong> <code>start-exec</code> in Mac Miller terminal</li>
          </ul>
        </section>
      </div>
    </main>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Executive Matchmaker', content, includeNav: false, statusClass: 'system-row' }));
});

app.get('/business-driver-legacy', (req, res) => {
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

const BUSINESS_DRIVER_ENDPOINTS = [
  '/api/business/search',
  '/api/business/counters',
  '/api/business/sparkline/pipeline',
  '/api/business/sparkline/modernization',
];

BUSINESS_DRIVER_ENDPOINTS.forEach((endpoint) => {
  app.get(endpoint, async (req, res) => {
    try {
      const items = [];
      const stable = stabilizeItems(items);
      const forecast = endpoint.includes('/sparkline/') ? await runForecast('modernization') : { items: [] };
      const narrative = endpoint.includes('/sparkline/') ? await runForecastNarrative('modernization') : { items: [] };
      res.json({ items: stable, forecast: forecast.items, narrative: narrative.items });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

app.get('/api/business/detail/:id', (req, res) => res.json({ items: stabilizeItems([]) }));

app.get('/business-driver-legacy-v3', (req, res) => {
  const content = `
    <div id="status-strip" class="business-status-strip" aria-live="polite">Loading Business Driver status...</div>

    <main class="business-blueprint">
      <div class="business-container">
        <section class="panel panel-left">
          <h2>Search Results</h2>
          <div class="business-search-row">
            <input id="internalSearchInput" type="search" placeholder="Search agencies, vendors, NAICS, PSC, awards, or keywords" />
            <button id="internalSearchBtn" type="button">Search</button>
          </div>
          <div id="search-results" class="feed">Run a search to load cards.</div>
        </section>

        <section class="panel panel-middle">
          <h2>Business Counters</h2>
          <div id="derived-counters" class="feed">Loading derived counters...</div>

          <h2>Pipeline Sparklines</h2>
          <div id="sparkline-pipeline" class="sparkline">Loading pipeline sparkline...</div>

          <h2>Modernization Sparklines</h2>
          <div id="sparkline-modernization" class="sparkline">Loading modernization sparkline...</div>
          <div id="forecast-modernization" class="sparkline-forecast">Loading modernization forecast...</div>
          <div id="modernization-narrative" class="forecast-narrative-block">Loading modernization narrative...</div>
        </section>

        <section class="panel panel-right">
          <h2>Detail</h2>
          <div id="hud-detail" class="feed">Select a search result to open its HUD detail.</div>
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

    <footer class="business-blueprint-footer">JE ROCKER LC • GovTech Intelligence Platform</footer>

    <script>
      (() => {
        const setText = (id, value) => {
          const element = document.getElementById(id);
          if (element) element.textContent = value;
        };
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderList = (id, items) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = items && items.length
            ? items.map((item) => '<article class="business-feed-item">' + escapeHtml(typeof item === 'string' ? item : item.title || JSON.stringify(item)) + '</article>').join('')
            : '<p class="business-feed-empty">No items available.</p>';
        };
        const renderSparkline = (id, items) => {
          const element = document.getElementById(id);
          if (!element) return;
          const values = items && items.length ? items : [1, 2, 3, 2, 4, 3];
          const max = Math.max(...values.map((value) => Number(value) || 0), 1);
          element.innerHTML = '<div class="business-sparkline-bars">' + values.map((value) => '<span style="height:' + Math.max(10, Math.round(((Number(value) || 0) / max) * 100)) + '%"></span>').join('') + '</div>';
        };
        const renderSparklineForecast = (id, items) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = items && items.length
            ? items.slice(0, 3).map((item) => {
              const regime = String(item.regime || 'Stable').toLowerCase();
              const regimeClass = regime === 'uptrend' ? 'up' : regime === 'downtrend' ? 'down' : regime;
              const icon = regime === 'uptrend' ? '▲' : regime === 'downtrend' ? '▼' : '■';
              return '<div class="business-forecast-row"><strong>' + escapeHtml(item.stableModernization || 'Unclassified modernization') + '</strong><span class="forecast-regime-' + escapeHtml(regimeClass) + '">' + icon + ' ' + escapeHtml(item.regime || 'Stable') + '</span><span>' + escapeHtml(String(item.projected_30_day_opportunity_count || 0)) + ' projected opportunities</span></div>';
            }).join('')
            : '<p class="business-feed-empty">No forecast data available.</p>';
        };
        const renderNarrative = (id, items) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = items && items.length
            ? items.slice(0, 3).map((item) => '<div class="narrative-item">' + escapeHtml(item.summary || '') + '</div>').join('')
            : '<p class="business-feed-empty">No narrative data available.</p>';
        };
        const renderDetail = (id, items) => renderList(id, items);
        const load = async (endpoint, target, render = renderList) => {
          try {
            const response = await fetch(endpoint, { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            render(target, data.items || []);
          } catch (_) {
            setText(target, 'Feed unavailable.');
          }
        };
        async function loadSearchResults() { await load('/api/business/search', 'search-results'); }
        async function loadCounters() { await load('/api/business/counters', 'derived-counters'); }
        async function loadPipelineSparkline() { await load('/api/business/sparkline/pipeline', 'sparkline-pipeline', renderSparkline); }
        async function loadModernizationSparkline() { await load('/api/business/sparkline/modernization', 'sparkline-modernization', renderSparkline); }
        async function loadModernizationForecast() { await load('/api/forecast/modernization', 'forecast-modernization', renderSparklineForecast); }
        async function loadModernizationNarrative() { await load('/api/forecast/narrative/modernization', 'modernization-narrative', renderNarrative); }
        async function loadHudDetail(id) {
          try {
            const response = await fetch('/api/business/detail/' + encodeURIComponent(id), { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            if (data.items && data.items.length) renderDetail('hud-detail', data.items);
          } catch (_) {
            // The selected search card is already rendered locally.
          }
        }

        const searchInput = document.getElementById('internalSearchInput');
        const searchButton = document.getElementById('internalSearchBtn');
        const searchResults = document.getElementById('search-results');
        const renderSearchCards = (rows) => {
          searchResults.innerHTML = rows.length
            ? rows.map((row, index) => '<button class="business-result-card" type="button" data-result-id="' + index + '"><strong>' + escapeHtml(row.title || row.name || row.vendor || row.agency || 'Search result') + '</strong><span>' + escapeHtml(row.agency || row.type || row.naics || 'Internal intelligence') + '</span></button>').join('')
            : '<p class="business-feed-empty">No matching internal results.</p>';
          Array.from(searchResults.querySelectorAll('.business-result-card')).forEach((card) => {
            card.addEventListener('click', () => {
              const row = rows[Number(card.dataset.resultId)];
              document.getElementById('hud-detail').innerHTML = Object.entries(row).map(([key, value]) => '<div class="business-detail-row"><span>' + escapeHtml(key.replaceAll('_', ' ')) + '</span><strong>' + escapeHtml(value) + '</strong></div>').join('');
              loadHudDetail(card.dataset.resultId);
            });
          });
        };
        const runSearch = async () => {
          const query = searchInput.value.trim();
          if (!query) return setText('search-results', 'Enter a search term.');
          setText('search-results', 'Searching internal intelligence...');
          try {
            const response = await fetch('/api/internal_search?q=' + encodeURIComponent(query), { cache: 'no-store' });
            if (!response.ok) throw new Error('Search failed');
            const data = await response.json();
            renderSearchCards(data.rows || []);
          } catch (_) {
            setText('search-results', 'Search unavailable.');
          }
        };
        searchButton.addEventListener('click', runSearch);
        searchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') runSearch(); });

        const setIndicator = (id, active) => {
          const element = document.getElementById(id);
          if (element) element.classList.toggle('indicator-active', active);
        };
        Promise.all([
          fetch('/api/system/state').then((response) => response.json()),
          fetch('/api/engine/last-refresh').then((response) => response.json()),
          fetch('/api/scraper/last-run').then((response) => response.json()),
          fetch('/api/matcher/last-run').then((response) => response.json()),
          fetch('/api/dashboard_summary').then((response) => response.json()),
        ]).then(([system, refresh, scraper, matcher, summary]) => {
          setText('status-strip', 'System: ' + (system.status || 'Unknown') + ' • Refresh: ' + (refresh.last_refresh || 'Unknown') + ' • Scraper: ' + (scraper.last_run || 'Unknown') + ' • Matcher: ' + (matcher.last_run || 'Unknown'));
          setIndicator('scraper-indicator', scraper.status === 'Ready');
          setIndicator('matcher-indicator', matcher.status === 'Ready');
          setIndicator('engine-indicator', refresh.pipeline_status === 'Ready');
          setIndicator('cluster-indicator', (system.cluster_nodes || []).some((node) => node.status === 'Active'));
          setText('cluster-banner', (system.cluster_nodes || []).map((node) => node.name + ' — ' + node.role + ': ' + node.status).join(' • '));
          renderList('derived-counters', [
            'Total opportunities: ' + (summary.total_opportunities || 0),
            'Total matches: ' + (summary.total_matches || 0),
            'Match coverage: ' + (summary.match_coverage || '0%'),
            'Forecasting signals: ' + (summary.forecasting_signals || 'Unknown'),
          ]);
          renderSparkline('sparkline-pipeline', [summary.total_opportunities, summary.matched_opportunities, summary.total_matches]);
          renderSparkline('sparkline-modernization', [summary.match_coverage?.replace('%', ''), 2, 3, 5]);
        }).catch(() => setText('status-strip', 'System status unavailable.'));

        Promise.all([loadSearchResults(), loadCounters(), loadPipelineSparkline(), loadModernizationSparkline(), loadModernizationForecast(), loadModernizationNarrative(), loadHudDetail('default')]);
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Business Driver', content }));
});

app.get('/business-driver', (req, res) => {
  const content = `
    <main class="business-driver-page">
      <div class="identity-center">
        <div class="cover-identity">
          <h1>Business Driver Cockpit</h1>
          <h2>Situational Awareness • Engines • Workflow • Control</h2>
        </div>
      </div>

      <div class="cockpit-row" style="margin-bottom:14px;">
        <section class="dark-block" style="width:100%;display:flex;justify-content:space-between;align-items:center;padding:12px 20px;background:rgba(15,23,42,0.85);border:1px solid #1e293b;border-radius:10px;box-sizing:border-box;flex-wrap:wrap;gap:10px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="background:#0284c7;color:#fff;padding:4px 10px;border-radius:9999px;font-size:11px;font-weight:700;">GOVTECH COMMERCIAL</span>
            <span style="color:#94a3b8;font-size:13px;">Contractor Onboarding, Proposal Workflows, and CRM Revenue Pipeline</span>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <a href="/govtech-dashboard" class="headhunter-button headhunter-button-secondary" style="font-size:12px;padding:6px 12px;text-decoration:none;">Operations Dashboard &rarr;</a>
            <a href="/govtech-pipeline" class="headhunter-button headhunter-button-secondary" style="font-size:12px;padding:6px 12px;text-decoration:none;">CRM Pipeline &rarr;</a>
            <a href="/govtech-intake" class="headhunter-button" style="font-size:12px;padding:6px 12px;text-decoration:none;">+ New Client Intake</a>
          </div>
        </section>
      </div>

      <div class="cockpit-row">
        <section class="dark-block cockpit-col"><h3 class="block-title">Database Snapshot</h3><div class="inner-box">
          <p>Total Opportunities: <strong id="db-total-opportunities">Loading...</strong></p><p>Total Clients: <strong id="db-total-clients">Loading...</strong></p><p>Total Matches: <strong id="db-total-matches">Loading...</strong></p><p>Coverage: <strong id="db-coverage">Loading...</strong></p><p>Last Update: <strong id="db-last-update">Loading...</strong></p>
        </div></section>
        <section class="dark-block cockpit-col"><h3 class="block-title">Client Snapshot</h3><div class="inner-box">
          <p>Total Clients: <strong id="clients-total">Loading...</strong></p><p>Tier 1: <strong id="clients-tier1">Loading...</strong></p><p>Tier 2: <strong id="clients-tier2">Loading...</strong></p><p>Tier 3: <strong id="clients-tier3">Loading...</strong></p><p>Tier Movement (7 days): <strong id="clients-tier-movement">Loading...</strong></p><p>Top Clients: <strong id="clients-top">Loading...</strong></p><p>Modernization: <strong id="clients-modernization">Loading...</strong></p><p>Risk: <strong id="clients-risk">Loading...</strong></p><p>Alignment: <strong id="portfolio-alignment">Loading...</strong></p>
          <div class="client-details"><button type="button" onclick="openBusinessDriverDetail('clients')">View Client Details</button></div>
        </div></section>
        <section class="dark-block cockpit-col"><h3 class="block-title">Upcoming Projects</h3><div class="inner-box">
          <p>Active Opportunities: <strong id="upcoming-active">Loading...</strong></p><p>Deadlines This Week: <strong id="upcoming-week">Loading...</strong></p><p>Deadlines This Month: <strong id="upcoming-month">Loading...</strong></p><p>SBIR Windows: <strong id="upcoming-sbir">Loading...</strong></p><p>State Deadlines: <strong id="upcoming-state">Loading...</strong></p>
          <div class="opportunity-details"><button type="button" onclick="openBusinessDriverDetail('upcoming')">View Opportunity Details</button></div>
        </div></section>
      </div>

      <div class="cockpit-row">
        <section class="dark-block cockpit-col"><h3 class="block-title">Today&apos;s Mission</h3><div class="inner-box"><p>Pending Tasks: <strong id="mission-pending">Loading...</strong></p><p>Blocks: <strong id="mission-blocks">Loading...</strong></p><p>Follow-ups: <strong id="mission-followups">Loading...</strong></p><p>Alerts: <strong id="mission-alerts">Loading...</strong></p><div class="mission-checklist"><button type="button" onclick="openBusinessDriverDetail('mission')">Open Checklist</button></div></div></section>
        <section class="dark-block cockpit-col"><h3 class="block-title">Outreach &amp; Communications</h3><div class="inner-box"><p>Clients Needing Outreach: <strong id="outreach-clients">Loading...</strong></p><p>Agencies Needing Follow-up: <strong id="outreach-agencies">Loading...</strong></p><p>Opportunities Needing Clarification: <strong id="outreach-opportunities">Loading...</strong></p><div class="outreach-details"><p class="outreach-placeholder" id="outreach-detail-line">Loading outreach surface...</p></div></div></section>
        <section class="dark-block cockpit-col"><h3 class="block-title">Calendar &amp; Upcoming</h3><div class="inner-box"><p>Today: <strong id="calendar-today">Loading...</strong></p><p>This Week: <strong id="calendar-week">Loading...</strong></p><p>This Month: <strong id="calendar-month">Loading...</strong></p><p>Submission Dates: <strong id="calendar-submissions">Loading...</strong></p></div></section>
      </div>

      <div class="cockpit-row">
        <section class="dark-block cockpit-col"><h3 class="block-title">Search</h3><div class="inner-box">
        <form class="business-driver-search" data-search-type="database"><input type="hidden" name="scope" value="database" /><label for="search-database">Search Database:</label><input id="search-database" name="q" type="search" placeholder="Search database..." /><button type="submit">Search</button></form>
        <form class="business-driver-search" data-search-type="opportunities"><input type="hidden" name="scope" value="opportunities" /><label for="search-opportunities">Search Opportunities:</label><input id="search-opportunities" name="q" type="search" placeholder="Search opportunities..." /><button type="submit">Search</button></form>
        <form class="business-driver-search" data-search-type="state"><input type="hidden" name="scope" value="state" /><label for="search-state">Search by State:</label><select id="search-state" name="state"><option value="">Select State</option><option value="AZ">Arizona</option><option value="CA">California</option><option value="FL">Florida</option><option value="NY">New York</option><option value="TX">Texas</option><option value="VA">Virginia</option></select><label for="search-state-keywords">Keywords:</label><input id="search-state-keywords" name="q" type="search" placeholder="Enter keywords..." /><button type="submit">Search</button></form>
        <div class="search-mode-indicator" id="search-mode-indicator">Mode: FEDERAL</div>
        <div class="search-results business-driver-search-results" id="business-driver-search-results"><div class="search-source">Showing results from: <span id="search-scope-label">None</span></div><p class="search-placeholder">Search results will appear here.</p></div>
        </div></section>
        <section class="dark-block cockpit-col"><h3 class="block-title">Quick Actions</h3><div class="inner-box"><button type="button" class="cockpit-disabled" onclick="runIngestion()">Run Ingestion</button><button type="button" class="cockpit-disabled" onclick="runMatcher()">Run Matcher</button><button type="button" class="cockpit-disabled" onclick="refreshEngines()">Refresh Engines</button><button type="button" class="cockpit-disabled" onclick="refreshCluster()">Refresh Cluster</button><p id="quick-action-status">Manual execution is inactive on this wiring node.</p></div></section>
        <section class="dark-block cockpit-col"><h3 class="block-title">Manual Controls</h3><div class="inner-box"><label><input type="checkbox" checked disabled /> Grants.gov</label><label><input type="checkbox" checked disabled /> SBIR</label><label><input type="checkbox" checked disabled /> SAM.gov</label><label><input type="checkbox" checked disabled /> State Ingestion</label></div></section>
      </div>

      <div class="cockpit-row cockpit-engine-row">
        <section class="dark-block cockpit-col"><h3 class="block-title">Ingestion Engine</h3><div class="inner-box"><p>Grants.gov: <strong id="ingestion-grants">Loading...</strong></p><p>SBIR: <strong id="ingestion-sbir">Loading...</strong></p><p>SAM.gov: <strong id="ingestion-sam">Loading...</strong></p><p>State: <strong id="ingestion-state">Loading...</strong></p><p>Last Run: <strong id="ingestion-engine-last-run">Loading...</strong></p></div></section>
        <section class="dark-block cockpit-col"><h3 class="block-title">Matcher Engine</h3><div class="inner-box"><p>Last Run: <strong id="matcher-last-run">Loading...</strong></p><p>Total Matches: <strong id="matcher-engine-total">Loading...</strong></p><p>Coverage: <strong id="matcher-engine-coverage">Loading...</strong></p></div></section>
        <section class="dark-block cockpit-col"><h3 class="block-title">Forecasting Engine</h3><div class="inner-box"><p>Stability: <strong id="forecast-engine-stability">Loading...</strong></p><p>Resilience: <strong id="forecast-engine-resilience">Loading...</strong></p><p>Shock: <strong id="forecast-engine-shock">Loading...</strong></p><p>Cycle: <strong id="forecast-cycle">Loading...</strong></p></div></section>
        <section class="dark-block cockpit-col"><h3 class="block-title">Cluster Engine</h3><div class="inner-box"><p>MacMiller: <strong id="cluster-macmiller">Loading...</strong></p><p>Macklemore: <strong id="cluster-macklemore">Loading...</strong></p><p>MacMal: <strong id="cluster-macmal">Loading...</strong></p><p>Activity: <strong id="cluster-activity">Loading...</strong></p></div></section>
        <section class="dark-block cockpit-col"><h3 class="block-title">Portfolio Engine</h3><div class="inner-box"><p>Active Categories: <strong>NAICS • PSC • Agency • Modernization</strong></p><p>Drift Suppression: <strong>Active</strong></p><p>Cycle Posture: <strong id="portfolio-posture">Loading...</strong></p><p>Strategy: <strong id="forecast-portfolio">Loading...</strong></p></div></section>
      </div>
    </main>
    <div id="cockpit-modal" class="modal hidden" role="dialog" aria-modal="true" aria-label="Cockpit detail">
      <div class="modal-content"><button type="button" class="modal-close" onclick="closeModal()" aria-label="Close">×</button><div id="modal-body"></div></div>
    </div>
    <script>
      (() => {
        window.openModal = (content) => {
          document.getElementById('modal-body').innerHTML = content;
          document.getElementById('cockpit-modal').classList.remove('hidden');
        };
        window.closeModal = () => document.getElementById('cockpit-modal').classList.add('hidden');
        const futureAction = (name) => {
          const status = document.getElementById('quick-action-status');
          if (status) status.textContent = name + ' is not enabled on this wiring node.';
        };
        window.runIngestion = () => futureAction('Run Ingestion');
        window.runMatcher = () => futureAction('Run Matcher');
        window.refreshEngines = () => futureAction('Refresh Engines');
        window.refreshCluster = () => futureAction('Refresh Cluster');
        window.openBusinessDriverDetail = (type) => {
          const block = document.createElement('div');
          block.dataset.type = 'business-' + type;
          window.DashboardExplainability?.openDetail(block);
        };
        let searchMode = 'federal';
        const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value ?? 'Unavailable'; };
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const compactText = (value, limit = 160) => {
          const text = String(value || '').replace(/\\s+/g, ' ').trim();
          return text.length > limit ? text.slice(0, limit - 3) + '...' : text;
        };
        const businessTypes = {
          'Database Snapshot': 'database',
          'Client Snapshot': 'clients',
          'Upcoming Projects': 'upcoming',
          "Today's Mission": 'mission',
          'Outreach & Communications': 'outreach',
          'Calendar & Upcoming': 'calendar',
          Search: 'search',
          'Quick Actions': 'quick',
          'Manual Controls': 'controls',
          'Ingestion Engine': 'ingestion',
          'Matcher Engine': 'matcher',
          'Forecasting Engine': 'forecasting',
          'Cluster Engine': 'cluster',
          'Portfolio Engine': 'portfolio',
        };
        document.querySelectorAll('.business-driver-page .dark-block').forEach((block) => {
          const title = block.querySelector('.block-title')?.textContent?.trim();
          if (!businessTypes[title]) return;
          block.classList.add('outer-block');
          block.dataset.type = 'business-' + businessTypes[title];
        });
        window.DashboardExplainability?.wireExplainability();
        const setSearchScopeLabel = (scope, state) => {
          const label = document.getElementById('search-scope-label');
          if (!label) return;
          label.textContent = scope === 'state' && state ? 'STATE (' + state.toUpperCase() + ')' : String(scope || 'None').toUpperCase();
        };
        const params = new URLSearchParams(window.location.search);
        if (params.get('scope')) setSearchScopeLabel(params.get('scope'), params.get('state'));
        Promise.all([
          fetch('/api/system/state').then((response) => response.json()),
          fetch('/api/dashboard_summary').then((response) => response.json()),
          fetch('/api/portfolio/stability').then((response) => response.json()),
          fetch('/api/portfolio/resilience').then((response) => response.json()),
          fetch('/api/portfolio/shock').then((response) => response.json()),
          fetch('/api/portfolio/cycle-trends').then((response) => response.json()),
          fetch('/api/briefing/portfolio').then((response) => response.json()),
        ]).then(([system, summary, stability, resilience, shock, trends, briefing]) => {
          const health = summary.pipeline_status || 'Ready';
          ['ingestion-grants', 'ingestion-sbir', 'ingestion-sam', 'ingestion-state'].forEach((id) => setText(id, health));
          setText('db-last-update', summary.last_scraper_run);
          setText('ingestion-health', health);
          setText('matcher-last-run', summary.last_matcher_run);
          setText('db-total-opportunities', summary.live_index_opportunities || summary.total_opportunities || 0);
          const clients = briefing.briefing?.clients || [];
          setText('db-total-clients', clients.length);
          setText('db-total-matches', summary.total_matches || 0);
          setText('db-coverage', summary.match_coverage || '0%');
          setText('matcher-cycle', trends.trends?.[0]?.regime_trend || 'Insufficient data');
          setText('clients-total', clients.length);
          setText('clients-top', clients.slice(0, 3).map((client) => client.clientName).join(' • ') || 'Unavailable');
          setText('clients-modernization', summary.forecasting_signals || 'Active');
          setText('clients-risk', shock.shocks?.some((item) => item.shock_detected) ? 'Shock detected' : 'No shock detected');
          setText('forecast-shock', shock.shocks?.some((item) => item.shock_detected) ? 'Detected' : 'No shock detected');
          setText('forecast-cycle', trends.trends?.[0]?.regime_trend || 'Insufficient data');
          setText('forecast-modernization', summary.forecasting_signals || 'Active');
          setText('forecast-portfolio', summary.pipeline_status || 'Ready');
          setText('forecast-engine-stability', stability.stability?.[0]?.stability || 'Insufficient data');
          setText('forecast-engine-resilience', resilience.resilience?.[0]?.resilience_level || 'Insufficient data');
          setText('forecast-engine-shock', shock.shocks?.some((item) => item.shock_detected) ? 'Detected' : 'No shock detected');
          const nodes = new Map((system.cluster_nodes || []).map((node) => [node.name, node.status]));
          setText('cluster-macmiller', nodes.get('MacMiller'));
          setText('cluster-macklemore', nodes.get('Macklemore'));
          setText('cluster-macmal', nodes.get('MacMal (M6)'));
          setText('cluster-activity', (system.cluster_nodes || []).filter((node) => node.status === 'Active').length + ' active node');
          setText('portfolio-posture', trends.trends?.[0]?.regime_trend || 'Insufficient data');
          setText('portfolio-alignment', clients.some((client) => Number(client.opportunity_score) > 0) ? 'Active' : 'Monitor');
          setText('upcoming-active', summary.live_index_opportunities || summary.total_opportunities || 0);
          setText('mission-alerts', shock.shocks?.filter((item) => item.shock_detected).length || 0);
        }).catch(() => document.querySelectorAll('.business-driver-page strong[id]').forEach((element) => { element.textContent = 'Unavailable'; }));

        fetch('/api/business-driver/summary', { cache: 'no-store' })
          .then((response) => response.ok ? response.json() : Promise.reject())
          .then((business) => {
            setText('clients-tier1', business.clients.tier1);
            setText('clients-tier2', business.clients.tier2);
            setText('clients-tier3', business.clients.tier3);
            setText('clients-tier-movement', business.clients.tierMovement);
            setText('upcoming-week', business.upcoming.deadlinesThisWeek);
            setText('upcoming-month', business.upcoming.deadlinesThisMonth);
            setText('upcoming-sbir', business.upcoming.sbirWindows);
            setText('upcoming-state', business.upcoming.stateDeadlines);
            setText('mission-pending', business.mission.pendingTasks);
            setText('mission-blocks', business.mission.blocks);
            setText('mission-followups', business.mission.followups);
            setText('mission-alerts', business.mission.alerts);
            setText('outreach-clients', business.outreach.clientsNeedingOutreach);
            setText('outreach-agencies', business.outreach.agenciesNeedingFollowup);
            setText('outreach-opportunities', business.outreach.opportunitiesNeedingClarification);
            setText('outreach-detail-line', business.outreach.clientsNeedingOutreach + ' clients and ' + business.outreach.agenciesNeedingFollowup + ' agencies are in the review surface.');
            setText('calendar-today', business.calendar.today);
            setText('calendar-week', business.calendar.week);
            setText('calendar-month', business.calendar.month);
            setText('calendar-submissions', business.calendar.submissionDates);
            setText('ingestion-engine-last-run', business.engines.ingestionLastRun);
            setText('matcher-engine-total', business.engines.matcherTotal);
            setText('matcher-engine-coverage', business.engines.matcherCoverage);
          })
          .catch(() => {});

        document.querySelectorAll('.business-driver-search').forEach((form) => {
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const inputs = Array.from(form.querySelectorAll('input'));
            const keywordInput = form.querySelector('input[name="q"]');
            const stateInput = form.querySelector('select[name="state"]');
            const query = (keywordInput?.value || stateInput?.value || inputs[0]?.value || '').trim();
            const results = document.getElementById('business-driver-search-results');
            const scope = form.querySelector('input[name="scope"]')?.value;
            searchMode = scope === 'state' ? 'state' : 'federal';
            document.getElementById('search-mode-indicator').textContent = 'Mode: ' + searchMode.toUpperCase();
            setSearchScopeLabel(scope, stateInput?.value);
            if (!query) { results.textContent = 'Enter a search term.'; return; }
            const scopeLabel = scope === 'state' && stateInput?.value
              ? 'STATE (' + stateInput.value.toUpperCase() + ')'
              : String(scope || 'None').toUpperCase();
            const source = '<div class="search-source">Showing results from: <span id="search-scope-label">' + escapeHtml(scopeLabel) + '</span></div>';
            results.textContent = 'Searching internal intelligence...';
            results.insertAdjacentHTML('afterbegin', source);
            try {
              const parameters = new URLSearchParams({ q: query, scope: scope || 'global' });
              if (stateInput?.value) parameters.set('state', stateInput.value);
              const response = await fetch('/api/internal_search?' + parameters.toString(), { cache: 'no-store' });
              if (!response.ok) throw new Error('Request failed');
              const data = await response.json();
              const rawRows = Array.isArray(data.rows)
                ? data.rows
                : Array.isArray(data.results)
                  ? data.results
                  : Object.values(data.rows || data.results || {}).flat().filter(Boolean);
              const count = Number(data.count ?? rawRows.length);
              const status = '<div class="business-driver-search-status">' + count + ' results for "' + escapeHtml(query) + '"</div>';
              results.innerHTML = source + status + (rawRows.length
                ? rawRows.slice(0, 15).map((row) => '<div class="business-driver-result"><strong>' + escapeHtml(compactText(row.title || row.name || row.vendor || row.agency || row.notice_id || 'Result', 110)) + '</strong><span>' + escapeHtml(compactText([row.agency || row.type || row.bucket || row.naics || '', row.deadline || row.response_date || '', row.source || ''].filter(Boolean).join(' | '), 170)) + '</span></div>').join('')
                : 'No matching internal results.');
            } catch (_) { results.textContent = 'Search unavailable.'; }
          });
        });
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Business Driver', content, statusClass: 'system-row' }));
});

const PRIMARY_PIPELINE_ENDPOINTS = [
  '/api/pipeline/matched',
  '/api/pipeline/ingested',
  '/api/mission/today',
  '/api/pulse/state',
];

PRIMARY_PIPELINE_ENDPOINTS.forEach((endpoint) => {
  app.get(endpoint, async (req, res) => {
    try {
      const items = [];
      const stable = stabilizeItems(items);
      const forecast = endpoint.startsWith('/api/pipeline/') || endpoint === '/api/pulse/state'
        ? await runForecast('pipeline')
        : { items: [] };
      const narrative = endpoint.startsWith('/api/pipeline/') || endpoint === '/api/pulse/state'
        ? await runForecastNarrative('pipeline')
        : { items: [] };
      res.json({ items: stable, forecast: forecast.items, narrative: narrative.items });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

app.get('/primary-dashboard-legacy', (req, res) => {
  const content = `
    <div id="status-strip" class="primary-status-strip" aria-live="polite">Loading Primary Dashboard status...</div>

    <main class="primary-blueprint">
      <div class="primary-container">
        <section class="panel panel-left">
          <h2>Opportunity Pipeline</h2>
          <div id="forecast-pipeline" class="forecast-block">Loading pipeline forecast...</div>
          <div id="pipeline-narrative" class="forecast-narrative-block">Loading pipeline narrative...</div>

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
        const renderForecast = (id, items) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = items && items.length
            ? items.slice(0, 5).map((item) => {
              const regime = String(item.regime || 'Stable').toLowerCase();
              const regimeClass = regime === 'uptrend' ? 'up' : regime === 'downtrend' ? 'down' : regime;
              return '<div class="primary-forecast-row"><strong>' + escapeHtml([item.stableNaics, item.stablePsc, item.stableAgency].filter(Boolean).join(' • ') || 'Unclassified pipeline') + '</strong><span>' + escapeHtml(String(item.projected_30_day_opportunity_count || 0)) + ' projected opportunities</span><span class="forecast-regime-' + escapeHtml(regimeClass) + '">' + escapeHtml(item.regime || 'Stable') + '</span><span class="forecast-confidence">' + escapeHtml(item.confidence || 'Low') + ' confidence</span></div>';
            }).join('')
            : '<p class="primary-feed-empty">No forecast data available.</p>';
        };
        const renderNarrative = (id, items) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = items && items.length
            ? items.slice(0, 3).map((item) => '<div class="narrative-item">' + escapeHtml(item.summary || '') + '</div>').join('')
            : '<p class="primary-feed-empty">No narrative data available.</p>';
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
        async function loadPipelineForecast() { await load('/api/forecast/pipeline', 'forecast-pipeline', renderForecast); }
        async function loadPipelineNarrative() { await load('/api/forecast/narrative/pipeline', 'pipeline-narrative', renderNarrative); }

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

        Promise.all([loadMatched(), loadIngested(), loadGrantIntelligence(), loadGrantOpportunities(), loadDailyMission(), loadPulse(), loadPipelineForecast(), loadPipelineNarrative()]);
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Primary Dashboard', content }));
});

app.get('/engine/primary/snapshot', async (req, res) => {
  const summary = await getClientIngestionSummary('1');
  res.json({ modernization: Number(summary.signals?.modernization || 0), readiness: Number(summary.signals?.readiness || 0) >= 70 ? 'High' : 'Medium', risk: Number(summary.signals?.risk || 0), momentum: Number(summary.signals?.momentum || 0) >= 60 ? 'Increasing' : 'Stable' });
});

app.get('/engine/primary/intelligence', async (req, res) => {
  const summary = await getClientIngestionSummary('1');
  res.json({ compliance: Number(summary.signals?.compliance || 0) >= 70 ? 'Good' : 'Needs review', modernization: Number(summary.signals?.modernization || 0) >= 70 ? 'Strong' : 'Developing', forecasting: summary.counts.opportunities || summary.counts.grants ? 'Live' : 'Unavailable', opportunityAlignment: Number(summary.score || 0) >= 70 ? 'High' : 'Developing', mission: summary.opportunities[0]?.title || 'No live opportunity selected', pulse: Number(summary.signals?.momentum || 0) >= 60 ? 'Increasing' : 'Stable' });
});

app.get('/engine/primary/opportunities', async (req, res) => {
  const opportunities = await loadLiveOpportunities();
  const agencies = [...new Set(opportunities.map((item) => item.agency).filter(Boolean))];
  res.json({ top10: opportunities.slice(0, 10), fullFeed: opportunities, agencies, momentum: opportunities.length ? 'Live' : 'No live opportunities' });
});

app.get('/engine/primary/predictor', async (req, res) => {
  const [summary, opportunities] = await Promise.all([getClientIngestionSummary('1'), loadLiveOpportunities()]);
  const dated = opportunities.filter((item) => parseDashboardDate(item.deadline));
  res.json({ scoreForecast: (Number(summary.score || 0) >= 70 ? 'High' : 'Developing') + ' live alignment', tierForecast: dated.length + ' dated windows', modernizationImpact: Number(summary.signals?.modernization || 0) >= 70 ? 'High' : 'Developing', opportunityUnlock: opportunities.filter((item) => item.source === 'state').length + ' state opportunities' });
});

app.get('/engine/primary/grants', async (req, res) => {
  const grants = await loadLiveGrants();
  const now = new Date();
  const windows = [...new Set(grants
    .map((grant) => ({ label: grant.deadline, parsed: parseDashboardDate(grant.deadline) }))
    .filter((item) => item.label && item.parsed && item.parsed >= now)
    .sort((a, b) => a.parsed - b.parsed)
    .map((item) => String(item.label).slice(0, 10)))];
  res.json({ top: grants.slice(0, 10), alignment: grants.length ? 'Live' : 'No live grants', windows, readiness: grants.some((grant) => grant.deadline) ? 'Active' : 'Monitor' });
});

app.get('/engine/primary/availability', async (req, res) => {
  const [grants, opportunities] = await Promise.all([loadLiveGrants(), loadLiveOpportunities()]);
  const agencies = [...new Set([...grants, ...opportunities].map((item) => item.agency).filter(Boolean))];
  const now = new Date();
  const windows = [...new Set([...grants, ...opportunities]
    .map((item) => ({ label: item.deadline, parsed: parseDashboardDate(item.deadline) }))
    .filter((item) => item.label && item.parsed && item.parsed >= now)
    .sort((a, b) => a.parsed - b.parsed)
    .map((item) => String(item.label).slice(0, 10)))];
  res.json({ newGrants: grants.slice(0, 25), newOpps: opportunities.slice(0, 25), agencyReleases: agencies, windowsOpening: windows });
});

app.get('/primary-dashboard', (req, res) => {
  const content = `
    <main class="dashboard-page primary-cockpit-page">
      <section class="outer-block system-status"><h3 class="panel-title">SYSTEM STATUS</h3><div class="inner-frame">SYSTEM: Ready | LAST SCRAPER: Available in shared status row | LAST MATCHER: Available in shared status row | LAST UPDATED: Available in shared status row | CLUSTER: MacMiller • Macklemore • MacMal</div></section>
      <section class="outer-block header-block"><h1 class="panel-title">JE ROCKER</h1><div class="inner-frame"><h2>Primary Intelligence Cockpit</h2></div></section>
      <div class="cockpit-row primary-snapshot-row">
        <section class="outer-block modernization-score"><h3 class="panel-title">Modernization Score</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block readiness"><h3 class="panel-title">Readiness</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block risk"><h3 class="panel-title">Risk</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block momentum"><h3 class="panel-title">Momentum</h3><div class="inner-frame"><p>Loading...</p></div></section>
      </div>
      <div class="cockpit-row primary-intelligence-row">
        <section class="outer-block compliance"><h3 class="panel-title">Compliance</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block modernization"><h3 class="panel-title">Modernization</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block forecasting"><h3 class="panel-title">Forecasting</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block opportunity-alignment"><h3 class="panel-title">Opportunity Alignment</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block mission"><h3 class="panel-title">Mission</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block pulse"><h3 class="panel-title">Pulse</h3><div class="inner-frame"><p>Loading...</p></div></section>
      </div>
      <div class="cockpit-row primary-opportunity-row">
        <section class="outer-block opp-top"><h3 class="panel-title">Top Matched Opportunities</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block opp-full"><h3 class="panel-title">Full Opportunity Feed</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block opp-agency"><h3 class="panel-title">Agency Alignment</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block opp-momentum"><h3 class="panel-title">Opportunity Momentum</h3><div class="inner-frame"><p>Loading...</p></div></section>
      </div>
      <div class="cockpit-row primary-predictor-row">
        <section class="outer-block score-forecast"><h3 class="panel-title">Score Forecast</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block tier-forecast"><h3 class="panel-title">Tier Forecast</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block modernization-impact"><h3 class="panel-title">Modernization Impact</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block opportunity-unlock"><h3 class="panel-title">Opportunity Unlock</h3><div class="inner-frame"><p>Loading...</p></div></section>
      </div>
      <div class="cockpit-row primary-grants-row">
        <section class="outer-block grants-top"><h3 class="panel-title">Top Grants Available</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block grants-alignment"><h3 class="panel-title">Grant Alignment</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block grants-windows"><h3 class="panel-title">Grant Submission Windows</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block grants-readiness"><h3 class="panel-title">Grant Readiness</h3><div class="inner-frame"><p>Loading...</p></div></section>
      </div>
      <section class="outer-block view-grants"><h3 class="panel-title">View Grants</h3><div class="inner-frame"><button type="button" id="show-primary-grants">Show All Grants</button><div id="primary-grant-list" class="inner-frame scrollable" hidden></div></div></section>
      <div class="cockpit-row primary-availability-row">
        <section class="outer-block new-grants"><h3 class="panel-title">New Grants Posted</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block new-opportunities"><h3 class="panel-title">New Opportunities Posted</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block new-agency-releases"><h3 class="panel-title">New Agency Releases</h3><div class="inner-frame"><p>Loading...</p></div></section><section class="outer-block new-windows"><h3 class="panel-title">New Windows Opening</h3><div class="inner-frame"><p>Loading...</p></div></section>
      </div>
      <section class="outer-block ingestion-controls"><h3 class="panel-title">Ingestion Engine</h3><div class="inner-frame"><div class="ingestion-actions"><button type="button" data-ingest-type="opportunities">Run Opportunities Ingestion</button><button type="button" data-ingest-type="grants">Run Grants Ingestion</button><button type="button" data-ingest-type="agencies">Run Agency Ingestion</button></div><p id="ingest-status" aria-live="polite">Manual ingestion is idle.</p></div></section>
      <section class="outer-block matcher-controls"><h3 class="panel-title">Matcher Engine</h3><div class="inner-frame"><div class="matcher-actions"><input id="matcher-client-id" type="text" placeholder="Client ID" aria-label="Client ID" /><button type="button" id="run-matcher-btn">Run Matcher</button></div><p id="matcher-status" aria-live="polite">Manual matcher is idle.</p></div></section>
      <section class="outer-block modernization-controls"><h3 class="panel-title">Modernization Engine</h3><div class="inner-frame"><div class="modernization-actions"><input id="modernization-client-id" type="text" placeholder="Client ID" aria-label="Client ID" /><button type="button" id="run-modernization-btn">Run Modernization</button></div><p id="modernization-status" aria-live="polite">Manual modernization is idle.</p></div></section>
      <section class="outer-block risk-controls"><h3 class="panel-title">Risk Engine</h3><div class="inner-frame"><div class="risk-actions"><input id="risk-client-id" type="text" placeholder="Client ID" aria-label="Client ID" /><button type="button" id="run-risk-btn">Run Risk</button></div><p id="risk-status" aria-live="polite">Manual risk is idle.</p></div></section>
      <section class="outer-block forecasting-controls"><h3 class="panel-title">Forecasting Engine</h3><div class="inner-frame"><div class="forecasting-actions"><input id="forecast-client-id" type="text" placeholder="Client ID" aria-label="Client ID" /><button type="button" id="run-forecast-btn">Run Forecast</button></div><p id="forecast-status" aria-live="polite">Manual forecasting is idle.</p></div></section>
      <section class="outer-block prioritization-controls"><h3 class="panel-title">Prioritization Engine</h3><div class="inner-frame"><div class="prioritization-actions"><input id="priority-client-id" type="text" placeholder="Client ID" aria-label="Client ID" /><button type="button" id="run-prioritization-btn">Run Prioritization</button></div><p id="priority-status" aria-live="polite">Manual prioritization is idle.</p></div></section>
      <section class="outer-block automation-controls"><h3 class="panel-title">Automation Layer</h3><div class="inner-frame"><div class="automation-actions"><button type="button" id="toggle-automation-btn">Toggle Automation</button><button type="button" data-automation-engine="ingestion">Toggle Ingestion Auto</button><button type="button" data-automation-engine="forecasting">Toggle Forecast Auto</button><button type="button" data-automation-engine="prioritization">Toggle Prioritization Auto</button></div><p id="automation-status" aria-live="polite">Loading automation status...</p></div></section>
      <section class="outer-block engine-state"><h3 class="panel-title">Engine State Map</h3><div class="inner-frame" id="engine-state-content" aria-live="polite">Loading audit stream...</div></section>
      <section class="outer-block kill-controls"><h3 class="panel-title">Kill Switches</h3><div class="inner-frame"><div class="kill-actions"><button type="button" data-kill-engine="global">Toggle Global Kill</button><button type="button" data-kill-engine="ingestion">Toggle Ingestion Kill</button><button type="button" data-kill-engine="matcher">Toggle Matcher Kill</button><button type="button" data-kill-engine="modernization">Toggle Modernization Kill</button><button type="button" data-kill-engine="risk">Toggle Risk Kill</button><button type="button" data-kill-engine="forecasting">Toggle Forecast Kill</button><button type="button" data-kill-engine="prioritization">Toggle Prioritization Kill</button><button type="button" data-kill-engine="automation">Toggle Automation Kill</button></div><p id="kill-status" aria-live="polite">Loading kill switch state...</p></div></section>
    </main>
    <script>
      (() => {
        window.runIngest = async (type) => {
          const status = document.getElementById('ingest-status');
          if (status) status.textContent = 'Running ' + type + ' ingestion...';
          try {
            const response = await fetch('/engine/ingest/' + encodeURIComponent(type) + '/run', { method: 'POST' });
            if (!response.ok) throw new Error('Ingestion failed');
            const data = await response.json();
            if (status) status.textContent = data.type + ' ingestion completed: ' + data.count + ' items';
            const ingestionStatus = document.getElementById('global-last-ingestion');
            if (ingestionStatus) ingestionStatus.textContent = data.type + ' | ' + data.finishedAt;
          } catch (_) {
            if (status) status.textContent = 'Ingestion unavailable.';
          }
        };
        document.querySelectorAll('[data-ingest-type]').forEach((button) => button.addEventListener('click', () => window.runIngest(button.dataset.ingestType)));
        window.runMatcher = async () => {
          const clientId = document.getElementById('matcher-client-id').value.trim();
          const status = document.getElementById('matcher-status');
          if (!clientId) { if (status) status.textContent = 'Enter a client ID.'; return; }
          if (status) status.textContent = 'Running matcher for ' + clientId + '...';
          try {
            const response = await fetch('/engine/matcher/client/' + encodeURIComponent(clientId) + '/run', { method: 'POST' });
            if (!response.ok) throw new Error('Matcher failed');
            const data = await response.json();
            if (status) status.textContent = 'Matched ' + data.resultCount + ' items for client ' + data.clientId;
            const matcherStatus = document.getElementById('global-last-matcher');
            if (matcherStatus) matcherStatus.textContent = data.clientId + ' | ' + data.finishedAt;
          } catch (_) {
            if (status) status.textContent = 'Matcher unavailable.';
          }
        };
        document.getElementById('run-matcher-btn').addEventListener('click', window.runMatcher);
        window.runModernization = async () => {
          const clientId = document.getElementById('modernization-client-id').value.trim();
          const status = document.getElementById('modernization-status');
          if (!clientId) { if (status) status.textContent = 'Enter a client ID.'; return; }
          if (status) status.textContent = 'Running modernization for ' + clientId + '...';
          try {
            const response = await fetch('/engine/modernization/client/' + encodeURIComponent(clientId) + '/run', { method: 'POST' });
            if (!response.ok) throw new Error('Modernization failed');
            const data = await response.json();
            if (status) status.textContent = 'Modernization posture: ' + data.posture + ' (' + data.blockers.length + ' blockers)';
            const modernizationStatus = document.getElementById('global-last-modernization');
            if (modernizationStatus) modernizationStatus.textContent = data.clientId + ' | ' + data.finishedAt;
          } catch (_) {
            if (status) status.textContent = 'Modernization unavailable.';
          }
        };
        document.getElementById('run-modernization-btn').addEventListener('click', window.runModernization);
        window.runRisk = async () => {
          const clientId = document.getElementById('risk-client-id').value.trim();
          const status = document.getElementById('risk-status');
          if (!clientId) { if (status) status.textContent = 'Enter a client ID.'; return; }
          if (status) status.textContent = 'Running risk for ' + clientId + '...';
          try {
            const response = await fetch('/engine/risk/client/' + encodeURIComponent(clientId) + '/run', { method: 'POST' });
            if (!response.ok) throw new Error('Risk evaluation failed');
            const data = await response.json();
            if (status) status.textContent = 'Risk posture: ' + data.posture + ' (C:' + data.risks.compliance + ', O:' + data.risks.operational + ', T:' + data.risks.technical + ')';
            const riskStatus = document.getElementById('global-last-risk');
            if (riskStatus) riskStatus.textContent = data.clientId + ' | ' + data.finishedAt;
          } catch (_) {
            if (status) status.textContent = 'Risk evaluation unavailable.';
          }
        };
        document.getElementById('run-risk-btn').addEventListener('click', window.runRisk);
        window.runForecast = async () => {
          const clientId = document.getElementById('forecast-client-id').value.trim();
          const status = document.getElementById('forecast-status');
          if (!clientId) { if (status) status.textContent = 'Enter a client ID.'; return; }
          if (status) status.textContent = 'Running forecast for ' + clientId + '...';
          try {
            const response = await fetch('/engine/forecast/client/' + encodeURIComponent(clientId) + '/run', { method: 'POST' });
            if (!response.ok) throw new Error('Forecast failed');
            const data = await response.json();
            if (status) status.textContent = 'Forecast: ' + data.outlook + ' (' + data.signals.length + ' signals, ' + data.trends.length + ' trends)';
            const forecastStatus = document.getElementById('global-last-forecast');
            if (forecastStatus) forecastStatus.textContent = data.clientId + ' | ' + data.finishedAt;
          } catch (_) {
            if (status) status.textContent = 'Forecast unavailable.';
          }
        };
        document.getElementById('run-forecast-btn').addEventListener('click', window.runForecast);
        window.runPrioritization = async () => {
          const clientId = document.getElementById('priority-client-id').value.trim();
          const status = document.getElementById('priority-status');
          if (!clientId) { if (status) status.textContent = 'Enter a client ID.'; return; }
          if (status) status.textContent = 'Running prioritization for ' + clientId + '...';
          try {
            const response = await fetch('/engine/prioritize/client/' + encodeURIComponent(clientId) + '/run', { method: 'POST' });
            if (!response.ok) throw new Error('Prioritization failed');
            const data = await response.json();
            if (status) status.textContent = 'Prioritized ' + data.opportunities.length + ' opportunities and ' + data.grants.length + ' grants';
            const priorityStatus = document.getElementById('global-last-prioritization');
            if (priorityStatus) priorityStatus.textContent = data.clientId + ' | ' + data.finishedAt;
          } catch (_) {
            if (status) status.textContent = 'Prioritization unavailable.';
          }
        };
        document.getElementById('run-prioritization-btn').addEventListener('click', window.runPrioritization);
        window.loadAllGrants = async () => {
          const response = await fetch('/engine/grants/all', { cache: 'no-store' });
          if (!response.ok) return;
          const data = await response.json();
          const target = document.getElementById('primary-grant-list');
          const escape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
          target.innerHTML = data.grants.map((grant) => '<div class="primary-grant-item">' + (grant.url ? '<a href="' + escape(grant.url) + '" target="_blank" rel="noopener noreferrer">' + escape(grant.title) + '</a>' : escape(grant.title)) + ' | ' + escape(grant.agency) + ' | ' + escape(grant.deadline || 'No deadline') + ' | ' + escape(String(grant.source || '').toUpperCase() + (grant.stateCode ? ' ' + grant.stateCode : '')) + '</div>').join('');
          target.hidden = false;
        };
        document.getElementById('show-primary-grants').addEventListener('click', window.loadAllGrants);
        const renderAutomationStatus = (data) => {
          const text = 'Global: ' + (data.automationEnabled ? 'ON' : 'OFF') + ' | Ingestion: ' + (data.config.ingestion ? 'ON' : 'OFF') + ' | Forecasting: ' + (data.config.forecasting ? 'ON' : 'OFF') + ' | Prioritization: ' + (data.config.prioritization ? 'ON' : 'OFF');
          const status = document.getElementById('automation-status');
          if (status) status.textContent = text;
          const shared = document.getElementById('global-automation-status');
          if (shared) shared.textContent = 'Global: ' + (data.automationEnabled ? 'ON' : 'OFF') + ' | I:' + (data.config.ingestion ? 'ON' : 'OFF') + ' F:' + (data.config.forecasting ? 'ON' : 'OFF') + ' P:' + (data.config.prioritization ? 'ON' : 'OFF');
        };
        const loadAutomationStatus = async () => {
          const response = await fetch('/engine/automation/status', { cache: 'no-store' });
          if (response.ok) renderAutomationStatus(await response.json());
        };
        window.toggleAutomation = async () => {
          const response = await fetch('/engine/automation/toggle', { method: 'POST' });
          if (response.ok) await loadAutomationStatus();
        };
        window.toggleAutomationEngine = async (engine) => {
          const response = await fetch('/engine/automation/' + encodeURIComponent(engine) + '/toggle', { method: 'POST' });
          if (response.ok) await loadAutomationStatus();
        };
        document.getElementById('toggle-automation-btn').addEventListener('click', window.toggleAutomation);
        document.querySelectorAll('[data-automation-engine]').forEach((button) => button.addEventListener('click', () => window.toggleAutomationEngine(button.dataset.automationEngine)));
        loadAutomationStatus().catch(() => {
          const status = document.getElementById('automation-status');
          if (status) status.textContent = 'Automation status unavailable.';
        });
        const loadEngineState = async () => {
          const response = await fetch('/engine/audit', { cache: 'no-store' });
          if (!response.ok) throw new Error('Audit unavailable');
          const events = await response.json();
          const target = document.getElementById('engine-state-content');
          if (!target) return;
          target.replaceChildren(...events.map((entry) => {
            const row = document.createElement('div');
            row.className = 'engine-state-entry';
            row.textContent = entry.timestamp + ' | ' + entry.event;
            return row;
          }));
          if (!events.length) target.textContent = 'No audit events recorded.';
        };
        const loadGuardrailStatus = async () => {
          const response = await fetch('/engine/guardrails/status', { cache: 'no-store' });
          if (!response.ok) throw new Error('Guardrail status unavailable');
          const guardrails = await response.json();
          const status = document.getElementById('kill-status');
          if (status) status.textContent = 'Global Kill: ' + (guardrails.killSwitch.global ? 'ON' : 'OFF') + ' | Killed: ' + (guardrails.killedEngines.join(', ') || 'None');
          const shared = document.getElementById('global-health-monitor');
          if (shared) shared.textContent = 'Global Kill: ' + (guardrails.killSwitch.global ? 'ON' : 'OFF') + ' | Killed: ' + (guardrails.killedEngines.join(', ') || 'None');
        };
        window.toggleKill = async (engine) => {
          const response = await fetch('/engine/kill/' + encodeURIComponent(engine) + '/toggle', { method: 'POST' });
          if (!response.ok) return;
          const data = await response.json();
          const status = document.getElementById('kill-status');
          if (status) status.textContent = data.engine + ' kill is now ' + (data.killed ? 'ON' : 'OFF');
          await Promise.all([loadEngineState(), loadGuardrailStatus()]);
        };
        document.querySelectorAll('[data-kill-engine]').forEach((button) => button.addEventListener('click', () => window.toggleKill(button.dataset.killEngine)));
        Promise.all([loadEngineState(), loadGuardrailStatus()]).catch(() => {
          const status = document.getElementById('kill-status');
          if (status) status.textContent = 'Guardrail status unavailable.';
        });
        const load = async (endpoint) => {
          const response = await fetch(endpoint, { cache: 'no-store' });
          if (!response.ok) throw new Error('Primary cockpit data unavailable');
          return response.json();
        };
        const setContent = (selector, value) => {
          const element = document.querySelector(selector + ' .inner-frame p');
          if (element) element.textContent = value;
        };
        async function loadPrimarySnapshot() {
          const snap = await load('/engine/primary/snapshot');
          setContent('.modernization-score', snap.modernization);
          setContent('.readiness', snap.readiness);
          setContent('.risk', snap.risk);
          setContent('.momentum', snap.momentum);
        }
        async function loadPrimaryIntelligence() {
          const intel = await load('/engine/primary/intelligence');
          setContent('.compliance', intel.compliance);
          setContent('.modernization', intel.modernization);
          setContent('.forecasting', intel.forecasting);
          setContent('.opportunity-alignment', intel.opportunityAlignment);
          setContent('.mission', intel.mission);
          setContent('.pulse', intel.pulse);
        }
        async function loadPrimaryOpportunities() {
          const opp = await load('/engine/primary/opportunities');
          setContent('.opp-top', opp.top10.length + ' items');
          setContent('.opp-full', opp.fullFeed.length + ' items');
          setContent('.opp-agency', opp.agencies?.length ? opp.agencies.length + ' agencies' : '3 agencies');
          setContent('.opp-momentum', 'Increasing');
        }
        async function loadPrimaryPredictor() {
          const predictor = await load('/engine/primary/predictor');
          setContent('.score-forecast', predictor.scoreForecast);
          setContent('.tier-forecast', predictor.tierForecast);
          setContent('.modernization-impact', predictor.modernizationImpact);
          setContent('.opportunity-unlock', predictor.opportunityUnlock);
        }
        async function loadPrimaryGrants() {
          const grants = await load('/engine/primary/grants');
          setContent('.grants-top', grants.top.length + ' grants');
          setContent('.grants-alignment', grants.alignment);
          setContent('.grants-windows', grants.windows.length + ' future windows');
          setContent('.grants-readiness', grants.readiness);
        }
        async function loadPrimaryAvailability() {
          const availability = await load('/engine/primary/availability');
          setContent('.new-grants', availability.newGrants.length + ' new');
          setContent('.new-opportunities', availability.newOpps.length + ' new');
          setContent('.new-agency-releases', availability.agencyReleases.length + ' releases');
          setContent('.new-windows', availability.windowsOpening.length + ' windows');
        }
        Promise.all([loadPrimarySnapshot(), loadPrimaryIntelligence(), loadPrimaryOpportunities(), loadPrimaryPredictor(), loadPrimaryGrants(), loadPrimaryAvailability()]).catch(() => {
          document.querySelectorAll('.primary-cockpit-page .inner-frame p').forEach((element) => { element.textContent = 'Unavailable'; });
        });
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER - Primary Intelligence Cockpit', content, statusClass: 'system-row' }));
});

app.get('/briefing', (req, res) => {
  const content = `
    <main class="briefing-container">
      <h2>Strategic Briefing</h2>
      <div id="briefing-pipeline" class="briefing-section">Loading pipeline briefing...</div>
      <div id="briefing-grants" class="briefing-section">Loading grants briefing...</div>
      <div id="briefing-modernization" class="briefing-section">Loading modernization briefing...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const titles = {
          'briefing-pipeline': 'Pipeline Forecast',
          'briefing-grants': 'Grant Forecast',
          'briefing-modernization': 'Modernization Forecast',
        };
        const renderBriefingSection = (id, section) => {
          const element = document.getElementById(id);
          if (!element) return;
          const narratives = section?.narrative || [];
          const forecastCount = section?.forecast?.length || 0;
          element.innerHTML = '<h3>' + titles[id] + '</h3><p>' + forecastCount + ' forecast groups analyzed.</p>'
            + (narratives.length
              ? narratives.map((item) => '<div class="narrative-item">' + escapeHtml(item.summary || '') + '</div>').join('')
              : '<p>No narrative data available.</p>');
        };
        async function loadBriefing() {
          try {
            const response = await fetch('/api/briefing', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderBriefingSection('briefing-pipeline', data.briefing?.pipeline);
            renderBriefingSection('briefing-grants', data.briefing?.grants);
            renderBriefingSection('briefing-modernization', data.briefing?.modernization);
          } catch (_) {
            ['briefing-pipeline', 'briefing-grants', 'briefing-modernization'].forEach((id) => {
              const element = document.getElementById(id);
              if (element) element.textContent = 'Strategic briefing unavailable.';
            });
          }
        }
        loadBriefing();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Strategic Briefing', content }));
});

app.get('/briefing/portfolio', (req, res) => {
  const content = `
    <main class="portfolio-briefing-container">
      <h2>Portfolio Strategic Briefing</h2>
      <div id="portfolio-briefing" class="portfolio-briefing-section">Loading portfolio briefing...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderPortfolioBriefing = (id, clients, actions) => {
          const element = document.getElementById(id);
          if (!element) return;
          const actionsByClientId = new Map((actions || []).map((action) => [String(action.clientId), action]));
          element.innerHTML = clients && clients.length
            ? clients.map((client) => {
              const action = actionsByClientId.get(String(client.clientId));
              const narratives = [
                ...client.narrative.pipeline,
                ...client.narrative.grants,
                ...client.narrative.modernization,
              ].slice(0, 3);
              return '<article class="client-entry"><h3>' + escapeHtml(client.clientName) + '</h3>'
                + '<p>Pipeline: ' + escapeHtml(client.pipeline_regime) + ' (' + escapeHtml(client.pipeline_confidence) + ' confidence)</p>'
                + '<p>Grants: ' + escapeHtml(client.grants_regime) + ' (' + escapeHtml(client.grants_confidence) + ' confidence)</p>'
                + '<p>Modernization: ' + escapeHtml(client.modernization_regime) + ' (' + escapeHtml(client.modernization_confidence) + ' confidence)</p>'
                + '<div class="portfolio-score"><span class="risk-score">Risk Score: <strong>' + escapeHtml(client.risk_score) + '</strong></span><span class="opportunity-score">Opportunity Score: <strong>' + escapeHtml(client.opportunity_score) + '</strong></span></div>'
                + (action ? '<div class="portfolio-action"><span class="portfolio-priority">Priority: <strong>' + escapeHtml(action.priority) + '</strong></span><div class="portfolio-recommendation">' + escapeHtml(action.recommendation) + '</div></div>' : '')
                + narratives.map((item) => '<div class="narrative-item">' + escapeHtml(item.summary || '') + '</div>').join('')
                + '</article>';
            }).join('')
            : '<p>No client briefings are available.</p>';
        };
        async function loadPortfolioBriefing() {
          try {
            const [briefingResponse, actionsResponse] = await Promise.all([
              fetch('/api/briefing/portfolio', { cache: 'no-store' }),
              fetch('/api/portfolio/actions', { cache: 'no-store' }),
            ]);
            if (!briefingResponse.ok || !actionsResponse.ok) throw new Error('Request failed');
            const [briefingData, actionsData] = await Promise.all([briefingResponse.json(), actionsResponse.json()]);
            renderPortfolioBriefing('portfolio-briefing', briefingData.briefing?.clients || [], actionsData.actions || []);
          } catch (_) {
            const element = document.getElementById('portfolio-briefing');
            if (element) element.textContent = 'Portfolio strategic briefing unavailable.';
          }
        }
        loadPortfolioBriefing();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Strategic Briefing', content }));
});

app.get('/portfolio/actions', (req, res) => {
  const content = `
    <main class="action-queue-container">
      <h2>Portfolio Action Queue</h2>
      <div id="action-queue" class="action-queue-section">Loading action queue...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderActionQueue = (id, queue) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = queue && queue.length
            ? queue.map((item) => '<article class="action-queue-entry"><div class="rank">#' + escapeHtml(item.rank) + '</div><h3>' + escapeHtml(item.clientName) + '</h3><p>Priority: ' + escapeHtml(item.priority) + ' | Opportunity: ' + escapeHtml(item.opportunity_score) + ' | Risk: ' + escapeHtml(item.risk_score) + '</p><div class="portfolio-recommendation">' + escapeHtml(item.recommendation) + '</div></article>').join('')
            : '<p>No portfolio actions are available.</p>';
        };
        async function loadActionQueue() {
          try {
            const response = await fetch('/api/portfolio/action-queue', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderActionQueue('action-queue', data.queue || []);
          } catch (_) {
            const element = document.getElementById('action-queue');
            if (element) element.textContent = 'Portfolio action queue unavailable.';
          }
        }
        loadActionQueue();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Action Queue', content }));
});

app.get('/portfolio/playbooks', (req, res) => {
  const content = `
    <main class="playbook-container">
      <h2>Portfolio Action Playbooks</h2>
      <div id="playbook-list" class="playbook-section">Loading action playbooks...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderPlaybooks = (id, playbooks) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = playbooks && playbooks.length
            ? playbooks.map((playbook) => '<article class="playbook-entry"><h3>' + escapeHtml(playbook.clientName) + '</h3><p>Priority: ' + escapeHtml(playbook.priority) + ' | Opportunity: ' + escapeHtml(playbook.opportunity_score) + ' | Risk: ' + escapeHtml(playbook.risk_score) + '</p><p>' + escapeHtml(playbook.recommendation) + '</p><ol class="steps">' + playbook.steps.map((step) => '<li>' + escapeHtml(step) + '</li>').join('') + '</ol></article>').join('')
            : '<p>No action playbooks are available.</p>';
        };
        async function loadPlaybooks() {
          try {
            const response = await fetch('/api/portfolio/playbooks', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderPlaybooks('playbook-list', data.playbooks || []);
          } catch (_) {
            const element = document.getElementById('playbook-list');
            if (element) element.textContent = 'Portfolio action playbooks unavailable.';
          }
        }
        loadPlaybooks();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Action Playbooks', content }));
});

app.get('/portfolio/cycle', (req, res) => {
  const content = `
    <main class="cycle-container">
      <h2>Portfolio Cycle Summary</h2>
      <div id="cycle-summary" class="cycle-section">Loading cycle summary...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderCycleSummary = (id, cycle) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = cycle && cycle.length
            ? cycle.map((entry) => '<article class="cycle-entry"><h3>' + escapeHtml(entry.clientName) + '</h3><p>Cycle status: ' + escapeHtml(entry.cycle_status) + '</p><div class="change">Regime: ' + escapeHtml(entry.regime_change) + '</div><div class="change">Confidence: ' + escapeHtml(entry.confidence_change) + '</div><div class="change">Volume: ' + escapeHtml(entry.volume_change) + '</div><div class="change">Risk posture: ' + escapeHtml(entry.risk_change) + '</div></article>').join('')
            : '<p>No portfolio cycle data is available.</p>';
        };
        async function loadCycleSummary() {
          try {
            const response = await fetch('/api/portfolio/cycle', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderCycleSummary('cycle-summary', data.cycle || []);
          } catch (_) {
            const element = document.getElementById('cycle-summary');
            if (element) element.textContent = 'Portfolio cycle summary unavailable.';
          }
        }
        loadCycleSummary();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Cycle Summary', content }));
});

app.get('/portfolio/cycle-trends', (req, res) => {
  const content = `
    <main class="cycle-trend-container">
      <h2>Portfolio Cycle Trends</h2>
      <div id="cycle-trend-list" class="cycle-trend-section">Loading cycle trends...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderCycleTrends = (id, trends) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = trends && trends.length
            ? trends.map((trend) => '<article class="cycle-trend-entry"><h3>' + escapeHtml(trend.clientName) + '</h3><div class="trend">Regime: ' + escapeHtml(trend.regime_trend) + '</div><div class="trend">Confidence: ' + escapeHtml(trend.confidence_trend) + '</div><div class="trend">Volume: ' + escapeHtml(trend.volume_trend) + '</div><div class="trend">Risk: ' + escapeHtml(trend.risk_trend) + '</div></article>').join('')
            : '<p>Insufficient cycle history to identify trends.</p>';
        };
        async function loadCycleTrends() {
          try {
            const response = await fetch('/api/portfolio/cycle-trends', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderCycleTrends('cycle-trend-list', data.trends || []);
          } catch (_) {
            const element = document.getElementById('cycle-trend-list');
            if (element) element.textContent = 'Portfolio cycle trends unavailable.';
          }
        }
        loadCycleTrends();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Cycle Trends', content }));
});

app.get('/portfolio/cycle-momentum', (req, res) => {
  const content = `
    <main class="cycle-momentum-container">
      <h2>Portfolio Cycle Momentum</h2>
      <div id="cycle-momentum-list" class="cycle-momentum-section">Loading cycle momentum...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderCycleMomentum = (id, momentum) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = momentum && momentum.length
            ? momentum.map((entry) => '<article class="cycle-momentum-entry"><h3>' + escapeHtml(entry.clientName) + '</h3><div class="momentum">Regime momentum: ' + escapeHtml(entry.momentum_regime) + '</div><div class="momentum">Confidence momentum: ' + escapeHtml(entry.momentum_confidence) + '</div><div class="momentum">Volume momentum: ' + escapeHtml(entry.momentum_volume) + '</div><div class="momentum">Risk momentum: ' + escapeHtml(entry.momentum_risk) + '</div></article>').join('')
            : '<p>Insufficient cycle history to calculate momentum.</p>';
        };
        async function loadCycleMomentum() {
          try {
            const response = await fetch('/api/portfolio/cycle-momentum', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderCycleMomentum('cycle-momentum-list', data.momentum || []);
          } catch (_) {
            const element = document.getElementById('cycle-momentum-list');
            if (element) element.textContent = 'Portfolio cycle momentum unavailable.';
          }
        }
        loadCycleMomentum();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Cycle Momentum', content }));
});

app.get('/portfolio/stability', (req, res) => {
  const content = `
    <main class="stability-container">
      <h2>Portfolio Stability</h2>
      <div id="stability-list" class="stability-section">Loading portfolio stability...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderStability = (id, stability) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = stability && stability.length
            ? stability.map((entry) => '<article class="stability-entry"><h3>' + escapeHtml(entry.clientName) + '</h3><div class="stability">Stability: ' + escapeHtml(entry.stability) + '</div><div class="stability">Total volatility: ' + escapeHtml(entry.total_volatility) + '</div><div class="stability">Regime: ' + escapeHtml(entry.volatility_regime) + ' | Confidence: ' + escapeHtml(entry.volatility_confidence) + ' | Volume: ' + escapeHtml(entry.volatility_volume) + ' | Risk: ' + escapeHtml(entry.volatility_risk) + '</div></article>').join('')
            : '<p>Insufficient cycle history to calculate stability.</p>';
        };
        async function loadStability() {
          try {
            const response = await fetch('/api/portfolio/stability', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderStability('stability-list', data.stability || []);
          } catch (_) {
            const element = document.getElementById('stability-list');
            if (element) element.textContent = 'Portfolio stability unavailable.';
          }
        }
        loadStability();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Stability', content }));
});

app.get('/portfolio/stability-forecast', (req, res) => {
  const content = `
    <main class="stability-forecast-container">
      <h2>Stability Forecast</h2>
      <div id="stability-forecast-list" class="stability-forecast-section">Loading stability forecast...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderStabilityForecast = (id, forecasts) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = forecasts && forecasts.length
            ? forecasts.map((forecast) => '<article class="stability-forecast-entry"><h3>' + escapeHtml(forecast.clientName) + '</h3><div class="forecast">Current stability: ' + escapeHtml(forecast.current_stability) + '</div><div class="forecast">Next-cycle forecast: ' + escapeHtml(forecast.forecast_stability) + '</div><div class="forecast">Forecast confidence: ' + escapeHtml(forecast.forecast_confidence) + '%</div><p>' + escapeHtml(forecast.rationale) + '</p></article>').join('')
            : '<p>Insufficient cycle history to forecast stability.</p>';
        };
        async function loadStabilityForecast() {
          try {
            const response = await fetch('/api/portfolio/stability-forecast', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderStabilityForecast('stability-forecast-list', data.forecasts || []);
          } catch (_) {
            const element = document.getElementById('stability-forecast-list');
            if (element) element.textContent = 'Portfolio stability forecast unavailable.';
          }
        }
        loadStabilityForecast();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Stability Forecast', content }));
});

app.get('/portfolio/stability-advisory', (req, res) => {
  const content = `
    <main class="stability-advisory-container">
      <h2>Stability Advisory</h2>
      <div id="stability-advisory-list" class="stability-advisory-section">Loading stability advisory...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderStabilityAdvisory = (id, advisory) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = advisory && advisory.length
            ? advisory.map((entry) => '<article class="stability-advisory-entry"><h3>' + escapeHtml(entry.clientName) + '</h3><div class="advisory">Level: ' + escapeHtml(entry.advisory_level) + '</div><div class="advisory">Current: ' + escapeHtml(entry.current_stability) + ' | Forecast: ' + escapeHtml(entry.forecast_stability) + ' | Confidence: ' + escapeHtml(entry.forecast_confidence) + '%</div><p>' + escapeHtml(entry.advisory_rationale) + '</p><ol class="steps">' + entry.advisory_actions.map((action) => '<li>' + escapeHtml(action) + '</li>').join('') + '</ol></article>').join('')
            : '<p>Insufficient stability data to generate advisories.</p>';
        };
        async function loadStabilityAdvisory() {
          try {
            const response = await fetch('/api/portfolio/stability-advisory', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderStabilityAdvisory('stability-advisory-list', data.advisory || []);
          } catch (_) {
            const element = document.getElementById('stability-advisory-list');
            if (element) element.textContent = 'Portfolio stability advisory unavailable.';
          }
        }
        loadStabilityAdvisory();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Stability Advisory', content }));
});

app.get('/portfolio/resilience', (req, res) => {
  const content = `
    <main class="resilience-container">
      <h2>Portfolio Resilience</h2>
      <div id="resilience-list" class="resilience-section">Loading portfolio resilience...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderResilience = (id, resilience) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = resilience && resilience.length
            ? resilience.map((entry) => '<article class="resilience-entry"><h3>' + escapeHtml(entry.clientName) + '</h3><div class="resilience">Resilience level: ' + escapeHtml(entry.resilience_level) + '</div><div class="resilience">Resilience score: ' + escapeHtml(entry.resilience_score) + '/100</div><p>' + escapeHtml(entry.rationale) + '</p></article>').join('')
            : '<p>Insufficient stability data to calculate resilience.</p>';
        };
        async function loadResilience() {
          try {
            const response = await fetch('/api/portfolio/resilience', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderResilience('resilience-list', data.resilience || []);
          } catch (_) {
            const element = document.getElementById('resilience-list');
            if (element) element.textContent = 'Portfolio resilience unavailable.';
          }
        }
        loadResilience();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Resilience', content }));
});

app.get('/portfolio/resilience-forecast', (req, res) => {
  const content = `
    <main class="resilience-forecast-container">
      <h2>Resilience Forecast</h2>
      <div id="resilience-forecast-list" class="resilience-forecast-section">Loading resilience forecast...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderResilienceForecast = (id, forecasts) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = forecasts && forecasts.length
            ? forecasts.map((forecast) => '<article class="resilience-forecast-entry"><h3>' + escapeHtml(forecast.clientName) + '</h3><div class="forecast">Current resilience: ' + escapeHtml(forecast.current_resilience_level) + ' (' + escapeHtml(forecast.current_resilience_score) + '/100)</div><div class="forecast">Forecast resilience: ' + escapeHtml(forecast.forecast_resilience_level) + ' (' + escapeHtml(forecast.forecast_resilience_score) + '/100)</div><div class="forecast">Forecast confidence: ' + escapeHtml(forecast.forecast_confidence) + '%</div><p>' + escapeHtml(forecast.rationale) + '</p></article>').join('')
            : '<p>Insufficient stability data to forecast resilience.</p>';
        };
        async function loadResilienceForecast() {
          try {
            const response = await fetch('/api/portfolio/resilience-forecast', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderResilienceForecast('resilience-forecast-list', data.forecasts || []);
          } catch (_) {
            const element = document.getElementById('resilience-forecast-list');
            if (element) element.textContent = 'Portfolio resilience forecast unavailable.';
          }
        }
        loadResilienceForecast();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Resilience Forecast', content }));
});

app.get('/portfolio/resilience-advisory', (req, res) => {
  const content = `
    <main class="resilience-advisory-container">
      <h2>Resilience Advisory</h2>
      <div id="resilience-advisory-list" class="resilience-advisory-section">Loading resilience advisory...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderResilienceAdvisory = (id, advisory) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = advisory && advisory.length
            ? advisory.map((entry) => '<article class="resilience-advisory-entry"><h3>' + escapeHtml(entry.clientName) + '</h3><div class="advisory">Level: ' + escapeHtml(entry.advisory_level) + '</div><div class="advisory">Current: ' + escapeHtml(entry.current_resilience_level) + ' | Forecast: ' + escapeHtml(entry.forecast_resilience_level) + ' | Score: ' + escapeHtml(entry.forecast_resilience_score) + '/100 | Confidence: ' + escapeHtml(entry.forecast_confidence) + '%</div><p>' + escapeHtml(entry.advisory_rationale) + '</p><ol class="steps">' + entry.advisory_actions.map((action) => '<li>' + escapeHtml(action) + '</li>').join('') + '</ol></article>').join('')
            : '<p>Insufficient resilience data to generate advisories.</p>';
        };
        async function loadResilienceAdvisory() {
          try {
            const response = await fetch('/api/portfolio/resilience-advisory', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderResilienceAdvisory('resilience-advisory-list', data.advisory || []);
          } catch (_) {
            const element = document.getElementById('resilience-advisory-list');
            if (element) element.textContent = 'Portfolio resilience advisory unavailable.';
          }
        }
        loadResilienceAdvisory();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Resilience Advisory', content }));
});

app.get('/portfolio/shock', (req, res) => {
  const content = `
    <main class="shock-container">
      <h2>Portfolio Shock Detection</h2>
      <div id="shock-list" class="shock-section">Loading shock detection...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderShock = (id, shocks) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = shocks && shocks.length
            ? shocks.map((shock) => '<article class="shock-entry"><h3>' + escapeHtml(shock.clientName) + '</h3><div class="shock">Status: ' + (shock.shock_detected ? 'Shock detected' : 'No shock detected') + '</div>' + (shock.shock_detected ? '<div class="shock">Type: ' + escapeHtml(shock.shock_type) + ' | Severity: ' + escapeHtml(shock.shock_severity) + '</div>' : '') + '<p>' + escapeHtml(shock.shock_rationale) + '</p></article>').join('')
            : '<p>Insufficient cycle history to detect shocks.</p>';
        };
        async function loadShock() {
          try {
            const response = await fetch('/api/portfolio/shock', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderShock('shock-list', data.shocks || []);
          } catch (_) {
            const element = document.getElementById('shock-list');
            if (element) element.textContent = 'Portfolio shock detection unavailable.';
          }
        }
        loadShock();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Shock Detection', content }));
});

app.get('/client/:clientId/briefing', (req, res) => {
  const clientId = Number.parseInt(String(req.params.clientId || ''), 10);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    return res.status(400).send('A valid client id is required.');
  }
  const content = `
    <main class="briefing-container client-briefing-container" data-client-id="${clientId}">
      <h2>Client Strategic Briefing</h2>
      <div id="client-briefing-pipeline" class="briefing-section client-briefing-section">Loading pipeline briefing...</div>
      <div id="client-briefing-grants" class="briefing-section client-briefing-section">Loading grants briefing...</div>
      <div id="client-briefing-modernization" class="briefing-section client-briefing-section">Loading modernization briefing...</div>
    </main>
    <script>
      (() => {
        window.clientId = document.querySelector('.client-briefing-container').dataset.clientId;
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const titles = {
          'client-briefing-pipeline': 'Pipeline Forecast',
          'client-briefing-grants': 'Grant Forecast',
          'client-briefing-modernization': 'Modernization Forecast',
        };
        const renderBriefingSection = (id, section) => {
          const element = document.getElementById(id);
          if (!element) return;
          const narratives = section?.narrative || [];
          const forecastCount = section?.forecast?.length || 0;
          element.innerHTML = '<h3>' + titles[id] + '</h3><p>' + forecastCount + ' client-fit forecast groups analyzed.</p>'
            + (narratives.length
              ? narratives.map((item) => '<div class="narrative-item">' + escapeHtml(item.summary || '') + '</div>').join('')
              : '<p>No client-fit narrative data available.</p>');
        };
        async function loadClientBriefing() {
          try {
            const response = await fetch('/api/briefing/client/' + encodeURIComponent(window.clientId), { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderBriefingSection('client-briefing-pipeline', data.briefing?.pipeline);
            renderBriefingSection('client-briefing-grants', data.briefing?.grants);
            renderBriefingSection('client-briefing-modernization', data.briefing?.modernization);
          } catch (_) {
            ['client-briefing-pipeline', 'client-briefing-grants', 'client-briefing-modernization'].forEach((id) => {
              const element = document.getElementById(id);
              if (element) element.textContent = 'Client strategic briefing unavailable.';
            });
          }
        }
        loadClientBriefing();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Client Strategic Briefing', content }));
});

app.get('/portfolio/shock-forecast', (req, res) => {
  const content = `
    <main class="shock-forecast-container">
      <h2>Shock Forecast</h2>
      <div id="shock-forecast-list" class="shock-forecast-section">Loading shock forecast...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderShockForecast = (id, forecasts) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = forecasts && forecasts.length
            ? forecasts.map((forecast) => '<article class="shock-forecast-entry"><h3>' + escapeHtml(forecast.clientName) + '</h3><div class="forecast">Forecast shock risk: ' + escapeHtml(forecast.forecast_shock_risk) + '</div><div class="forecast">Forecast confidence: ' + escapeHtml(forecast.forecast_confidence) + '%</div><p>' + escapeHtml(forecast.rationale) + '</p></article>').join('')
            : '<p>Insufficient portfolio data to forecast shocks.</p>';
        };
        async function loadShockForecast() {
          try {
            const response = await fetch('/api/portfolio/shock-forecast', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderShockForecast('shock-forecast-list', data.forecasts || []);
          } catch (_) {
            const element = document.getElementById('shock-forecast-list');
            if (element) element.textContent = 'Portfolio shock forecast unavailable.';
          }
        }
        loadShockForecast();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Shock Forecast', content }));
});

app.get('/portfolio/shock-advisory', (req, res) => {
  const content = `
    <main class="shock-advisory-container">
      <h2>Shock Advisory</h2>
      <div id="shock-advisory-list" class="shock-advisory-section">Loading shock advisory...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const renderShockAdvisory = (id, advisory) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = advisory && advisory.length
            ? advisory.map((entry) => '<article class="shock-advisory-entry"><h3>' + escapeHtml(entry.clientName) + '</h3><div class="advisory">Level: ' + escapeHtml(entry.advisory_level) + '</div><div class="advisory">Forecast risk: ' + escapeHtml(entry.forecast_shock_risk) + ' | Confidence: ' + escapeHtml(entry.forecast_confidence) + '%</div><p>' + escapeHtml(entry.advisory_rationale) + '</p><ol class="steps">' + entry.advisory_actions.map((action) => '<li>' + escapeHtml(action) + '</li>').join('') + '</ol></article>').join('')
            : '<p>Insufficient shock data to generate advisories.</p>';
        };
        async function loadShockAdvisory() {
          try {
            const response = await fetch('/api/portfolio/shock-advisory', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderShockAdvisory('shock-advisory-list', data.advisory || []);
          } catch (_) {
            const element = document.getElementById('shock-advisory-list');
            if (element) element.textContent = 'Portfolio shock advisory unavailable.';
          }
        }
        loadShockAdvisory();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Portfolio Shock Advisory', content }));
});

app.get('/portfolio/intelligence-overview-legacy', (req, res) => {
  const content = `
    <main class="intelligence-overview-container">
      <h2>Intelligence Overview</h2>
      <div id="intelligence-overview-list" class="intelligence-overview-section">Loading intelligence overview...</div>
    </main>
    <script>
      (() => {
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const detail = (label, value) => '<div class="section-block"><strong>' + label + ':</strong> ' + escapeHtml(value ?? 'Unavailable') + '</div>';
        const renderIntelligenceOverview = (id, overview) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = overview && overview.length
            ? overview.map((entry) => '<article class="intelligence-overview-entry"><h3>' + escapeHtml(entry.clientName) + '</h3>'
              + '<div class="section-title">Strategic Briefing</div>'
              + detail('Pipeline regime', entry.briefing?.pipeline_regime) + detail('Opportunity score', entry.portfolio?.opportunity_score)
              + '<div class="section-title">Stability</div>'
              + detail('Current', entry.stability?.stability) + detail('Forecast', entry.stability_forecast?.forecast_stability) + detail('Advisory', entry.stability_advisory?.advisory_level)
              + '<div class="section-title">Resilience</div>'
              + detail('Current', entry.resilience?.resilience_level) + detail('Forecast', entry.resilience_forecast?.forecast_resilience_level) + detail('Advisory', entry.resilience_advisory?.advisory_level)
              + '<div class="section-title">Shock</div>'
              + detail('Latest', entry.shock?.shock_type || 'None') + detail('Forecast risk', entry.shock_forecast?.forecast_shock_risk) + detail('Advisory', entry.shock_advisory?.advisory_level)
              + '<div class="section-title">Cycle Intelligence</div>'
              + detail('Trend', entry.cycle_trends?.regime_trend) + detail('Momentum', entry.cycle_momentum?.momentum_regime) + detail('Volatility', entry.stability?.total_volatility)
              + '<div class="section-title">Action Engine</div>'
              + detail('Priority', entry.actions?.priority) + detail('Recommended action', entry.actions?.recommendation)
              + '</article>').join('')
            : '<p>No portfolio intelligence is available.</p>';
        };
        async function loadIntelligenceOverview() {
          try {
            const response = await fetch('/api/portfolio/intelligence-overview', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderIntelligenceOverview('intelligence-overview-list', data.overview || []);
          } catch (_) {
            const element = document.getElementById('intelligence-overview-list');
            if (element) element.textContent = 'Portfolio intelligence overview unavailable.';
          }
        }
        loadIntelligenceOverview();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Intelligence Overview', content }));
});

app.get('/engine/intel-overview/engines', async (req, res) => {
  const [grants, opportunities] = await Promise.all([loadLiveGrants(), loadLiveOpportunities()]);
  res.json({ modernization: 'Live', matcher: opportunities.length + ' opportunities', risk: 'Advisory', forecasting: grants.length + ' grants' });
});

app.get('/engine/intel-overview/opportunities', async (req, res) => {
  const opportunities = await loadLiveOpportunities();
  res.json({ top: opportunities.slice(0, 10), agency: [...new Set(opportunities.map((item) => item.agency).filter(Boolean))], windows: [...new Set(opportunities.map((item) => item.deadline).filter(Boolean))], momentum: opportunities.length ? 'Live' : 'No live opportunities' });
});

app.get('/engine/intel-overview/modernization', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.query.clientId || '1'));
  const blockers = Object.entries(summary.axisScores || {}).filter(([, score]) => Number(score) < 50).map(([axis]) => axis + ' alignment needs review');
  res.json({ posture: Number(summary.signals?.modernization || 0) >= 70 ? 'Strong' : 'Developing', blockers, actions: summary.opportunities.slice(0, 2).map((item) => 'Review modernization fit for ' + (item.title || 'top live opportunity')), impact: Number(summary.signals?.modernization || 0) >= 70 ? 'High' : 'Developing' });
});

app.get('/engine/intel-overview/risk-compliance', async (req, res) => {
  const summary = await getClientIngestionSummary(String(req.query.clientId || '1'));
  const riskFactors = Object.entries(summary.axisScores || {}).filter(([, score]) => Number(score) < 50).map(([axis]) => axis + ' score below target');
  res.json({ riskFactors, complianceStatus: Number(summary.signals?.compliance || 0) >= 70 ? 'Good' : 'Needs review', complianceActions: ['Review live compliance score ' + Number(summary.signals?.compliance || 0)], complianceSignals: ['Live ingestion ' + (summary.timestamp || 'not run')] });
});

app.get('/engine/intel-overview/forecasting', async (req, res) => {
  const [grants, opportunities] = await Promise.all([loadLiveGrants(), loadLiveOpportunities()]);
  res.json({ signals: [`${grants.length} live grants`, `${opportunities.length} live opportunities`], trends: ['Live dataset active'], spending: summarizeOpportunities(opportunities).agencyDistribution, outlook: opportunities.length || grants.length ? 'Live' : 'No live data', unlock: `${opportunities.filter((item) => item.source === 'state').length} state opportunities emerging` });
});

app.get('/portfolio/intelligence-overview', (req, res) => {
  const panel = (className, title, type) => '<section class="outer-block ' + className + '" data-type="' + type + '"><h3 class="panel-title">' + title + '</h3><div class="inner-frame"><p>Loading...</p></div></section>';
  const content = `
    <main class="dashboard-page intelligence-overview-cockpit">
      <section class="outer-block system-status" data-type="summary-system"><h3 class="panel-title">SYSTEM STATUS</h3><div class="inner-frame">SYSTEM: Ready | LAST SCRAPER: Available in shared status row | LAST MATCHER: Available in shared status row | LAST UPDATED: Available in shared status row | CLUSTER: MacMiller • Macklemore • MacMal</div></section>
      <section class="outer-block header-block"><h1 class="panel-title">JE ROCKER Intelligence Overview</h1><div class="inner-frame"><h2>System Intelligence Map</h2></div></section>
      <section class="outer-block system-intelligence-summary" data-type="summary-system"><h3 class="panel-title">System Intelligence Summary</h3><div class="inner-frame"><p class="panel-desc">High-level summary of system-wide signals, trends, posture, blockers, and forecasting.</p></div></section>
      <div class="cockpit-row">${panel('eng-modernization', 'Modernization Engine', 'modernization-impact')}${panel('eng-matcher', 'Matcher Engine', 'top-matched-opportunities')}${panel('eng-risk', 'Risk Engine', 'risk')}${panel('eng-forecasting', 'Forecasting Engine', 'forecasting')}</div>
      <div class="cockpit-row">${panel('opp-top', 'Top Opportunities', 'top-matched-opportunities')}${panel('opp-agency', 'Agency Alignment', 'agency-breakdown')}${panel('opp-windows', 'Submission Windows', 'new-windows-opening')}${panel('opp-momentum', 'Opportunity Momentum', 'momentum')}</div>
      <div class="cockpit-row">${panel('mod-posture', 'Modernization Posture', 'modernization')}${panel('mod-blockers', 'Modernization Blockers', 'modernization-impact')}${panel('mod-actions', 'Modernization Actions', 'modernization-impact')}${panel('mod-impact', 'Modernization Impact', 'modernization-impact')}</div>
      <div class="cockpit-row">${panel('risk-factors', 'Risk Factors', 'risk')}${panel('compliance-status', 'Compliance Status', 'compliance')}${panel('compliance-actions', 'Compliance Actions', 'compliance')}${panel('compliance-signals', 'Compliance Signals', 'compliance')}</div>
      <div class="cockpit-row">${panel('fc-signals', 'Forecast Signals', 'forecasting')}${panel('fc-trends', 'Trend Lines', 'forecasting')}${panel('fc-spending', 'Spending Patterns', 'forecasting')}${panel('fc-outlook', 'Next Quarter Outlook', 'forecasting')}${panel('fc-unlock', 'Opportunity Unlock Forecast', 'opportunity-unlock')}</div>
    </main>
    <script>
      (() => {
        const load = async (endpoint) => {
          const response = await fetch(endpoint, { cache: 'no-store' });
          if (!response.ok) throw new Error('Intelligence Overview data unavailable');
          return response.json();
        };
        const setContent = (selector, value) => {
          const element = document.querySelector(selector + ' .inner-frame p');
          if (element) element.textContent = value;
        };
        async function loadIntelOverviewEngines() {
          const engines = await load('/engine/intel-overview/engines');
          setContent('.eng-modernization', engines.modernization); setContent('.eng-matcher', engines.matcher); setContent('.eng-risk', engines.risk); setContent('.eng-forecasting', engines.forecasting);
        }
        async function loadIntelOverviewOpportunities() {
          const opportunities = await load('/engine/intel-overview/opportunities');
          setContent('.opp-top', opportunities.top.length + ' items'); setContent('.opp-agency', opportunities.agency.length + ' agencies'); setContent('.opp-windows', opportunities.windows.length + ' windows'); setContent('.opp-momentum', opportunities.momentum);
        }
        async function loadIntelOverviewModernization() {
          const modernization = await load('/engine/intel-overview/modernization');
          setContent('.mod-posture', modernization.posture); setContent('.mod-blockers', modernization.blockers.length + ' blockers'); setContent('.mod-actions', modernization.actions.length + ' actions'); setContent('.mod-impact', modernization.impact);
        }
        async function loadIntelOverviewRiskCompliance() {
          const riskCompliance = await load('/engine/intel-overview/risk-compliance');
          setContent('.risk-factors', riskCompliance.riskFactors.length + ' factors'); setContent('.compliance-status', riskCompliance.complianceStatus); setContent('.compliance-actions', riskCompliance.complianceActions.length + ' actions'); setContent('.compliance-signals', riskCompliance.complianceSignals.length + ' signals');
        }
        async function loadIntelOverviewForecasting() {
          const forecasting = await load('/engine/intel-overview/forecasting');
          setContent('.fc-signals', forecasting.signals.length + ' signals'); setContent('.fc-trends', forecasting.trends.length + ' trends'); setContent('.fc-spending', Object.keys(forecasting.spending || {}).length + ' patterns'); setContent('.fc-outlook', forecasting.outlook); setContent('.fc-unlock', forecasting.unlock);
        }
        Promise.all([loadIntelOverviewEngines(), loadIntelOverviewOpportunities(), loadIntelOverviewModernization(), loadIntelOverviewRiskCompliance(), loadIntelOverviewForecasting()]).catch(() => {
          document.querySelectorAll('.intelligence-overview-cockpit .inner-frame p').forEach((element) => { element.textContent = 'Unavailable'; });
        });
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER - Intelligence Overview', content, statusClass: 'system-row' }));
});

app.get('/portfolio/more-intelligence-legacy', (req, res) => {
  const content = `
    <main class="more-intel-container">
      <h2>More Intelligence</h2>
      <p class="more-intel-description">Access all secondary intelligence engines and diagnostic modules.</p>
      <section class="more-intel-section">
        <h3 class="more-intel-group">Stability Engines</h3>
        <ul class="more-intel-list">
          <li><a href="/portfolio/stability">Stability</a></li>
          <li><a href="/portfolio/stability-forecast">Stability Forecast</a></li>
          <li><a href="/portfolio/stability-advisory">Stability Advisory</a></li>
        </ul>
        <h3 class="more-intel-group">Resilience Engines</h3>
        <ul class="more-intel-list">
          <li><a href="/portfolio/resilience">Resilience</a></li>
          <li><a href="/portfolio/resilience-forecast">Resilience Forecast</a></li>
          <li><a href="/portfolio/resilience-advisory">Resilience Advisory</a></li>
        </ul>
        <h3 class="more-intel-group">Shock Engines</h3>
        <ul class="more-intel-list">
          <li><a href="/portfolio/shock">Shock Detection</a></li>
          <li><a href="/portfolio/shock-forecast">Shock Forecast</a></li>
          <li><a href="/portfolio/shock-advisory">Shock Advisory</a></li>
        </ul>
        <h3 class="more-intel-group">Cycle Engines</h3>
        <ul class="more-intel-list">
          <li><a href="/portfolio/cycle">Cycle Summary</a></li>
          <li><a href="/portfolio/cycle-trends">Cycle Trends</a></li>
          <li><a href="/portfolio/cycle-momentum">Cycle Momentum</a></li>
        </ul>
        <h3 class="more-intel-group">Portfolio Engines</h3>
        <ul class="more-intel-list">
          <li><a href="/briefing/portfolio">Portfolio Briefing</a></li>
          <li><a href="/portfolio/intelligence-overview">Portfolio Intelligence</a></li>
          <li><a href="/portfolio/actions">Action Engine</a></li>
          <li><a href="/portfolio/action-queue">Action Queue</a></li>
          <li><a href="/portfolio/playbooks">Action Playbooks</a></li>
        </ul>
      </section>
    </main>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - More Intelligence', content }));
});

app.get('/engine/more-intel/signals', async (req, res) => {
  const [grants, opportunities] = await Promise.all([loadLiveGrants(), loadLiveOpportunities()]);
  res.json({ opportunity: [`${opportunities.length} live opportunities`], grant: [`${grants.length} live grants`], modernization: ['Live modernization overlay'], risk: ['Live risk overlay'] });
});

app.get('/engine/more-intel/trends', async (req, res) => {
  const opportunities = await loadLiveOpportunities();
  const summary = summarizeOpportunities(opportunities);
  res.json({ opportunity: [opportunities.length ? 'Live' : 'No live opportunities'], grant: ['Live grants active'], agency: Object.keys(summary.agencyDistribution).slice(0, 3), spending: Object.keys(summary.deadlineWindows).slice(0, 3) });
});

app.get('/engine/more-intel/posture', (req, res) => {
  res.json({ agency: 'Strong', modernization: 'Aligned', compliance: 'Good', risk: 'Low' });
});

app.get('/engine/more-intel/blockers', (req, res) => {
  res.json({ modernization: ['Website outdated'], compliance: ['SAM renewal'], operational: ['No intake workflow'], technical: ['Legacy hosting'] });
});

app.get('/engine/more-intel/forecasting', (req, res) => {
  res.json({ signals: ['HHS spending up'], trends: ['Upward'], spending: ['HHS +12%', 'DOE +8%'], outlook: 'Positive', unlock: '4 new aligned opportunities' });
});

function extractMoreIntelTarget(req) {
  return {
    agency: String(req.params.agency || 'ALL'),
    naics: String(req.params.naics || 'ALL'),
    geo: String(req.params.geo || 'ALL'),
  };
}

app.get('/engine/more-intel/:agency/:naics/:geo/signals', (req, res) => {
  const target = extractMoreIntelTarget(req);
  res.json({ opportunity: ['Signals for ' + target.agency + '/' + target.naics + '/' + target.geo], grant: ['Grant signals for ' + target.agency], modernization: ['Modernization signals for ' + target.naics], risk: ['Risk signals for ' + target.geo] });
});

app.get('/engine/more-intel/:agency/:naics/:geo/trends', (req, res) => {
  const target = extractMoreIntelTarget(req);
  res.json({ opportunity: ['Opportunity trends for ' + target.agency], grant: ['Grant trends for ' + target.naics], agency: ['Agency trends for ' + target.agency], spending: ['Spending trends for ' + target.geo] });
});

app.get('/engine/more-intel/:agency/:naics/:geo/posture', (req, res) => {
  const target = extractMoreIntelTarget(req);
  res.json({ agency: 'Agency posture for ' + target.agency, modernization: 'Modernization posture for ' + target.naics, compliance: 'Compliance posture for ' + target.geo, risk: 'Risk posture for ' + target.agency + '/' + target.geo });
});

app.get('/engine/more-intel/:agency/:naics/:geo/blockers', (req, res) => {
  const target = extractMoreIntelTarget(req);
  res.json({ modernization: ['Modernization blockers for ' + target.naics], compliance: ['Compliance blockers for ' + target.agency], operational: ['Operational blockers for ' + target.geo], technical: ['Technical blockers for ' + target.agency + '/' + target.naics] });
});

app.get('/engine/more-intel/:agency/:naics/:geo/forecasting', (req, res) => {
  const target = extractMoreIntelTarget(req);
  res.json({ signals: ['Forecast signals for ' + target.agency], trends: ['Forecast trends for ' + target.naics], spending: ['Spending patterns for ' + target.geo], outlook: 'Outlook for ' + target.agency + '/' + target.naics + '/' + target.geo, unlock: 'Unlock forecast for ' + target.agency });
});

function extractMoreIntelOverlay(req) {
  return {
    client: String(req.params.client || 'SYSTEM'),
    agency: String(req.params.agency || 'ALL'),
    naics: String(req.params.naics || 'ALL'),
    geo: String(req.params.geo || 'ALL'),
  };
}

function matchesLiveTarget(item, target) {
  const agencyOk = target.agency === 'ALL' || String(item.agency || '').toUpperCase().includes(target.agency);
  const naicsOk = target.naics === 'ALL' || String(item.naics || '').includes(target.naics);
  const geoOk = target.geo === 'ALL' || String(item.stateCode || '').toUpperCase() === target.geo || String(item.description || '').toUpperCase().includes(target.geo);
  return agencyOk && naicsOk && geoOk;
}

function topKeys(counts, limit = 3) {
  const keys = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, count]) => key + ' (' + count + ')');
  return keys.length ? keys : ['No live matches'];
}

app.get('/engine/more-intel/:client/:agency/:naics/:geo/signals', async (req, res) => {
  const target = extractMoreIntelOverlay(req);
  const [grants, opportunities] = await Promise.all([loadLiveGrants(), loadLiveOpportunities()]);
  const targetedGrants = grants.filter((item) => matchesLiveTarget(item, target));
  const targetedOpportunities = opportunities.filter((item) => matchesLiveTarget(item, target));
  res.json({ opportunity: [targetedOpportunities.length + ' live opportunities for ' + target.client + '/' + target.agency + '/' + target.naics + '/' + target.geo], grant: [targetedGrants.length + ' live grants for ' + target.client + '/' + target.agency], modernization: ['Live modernization overlay for ' + target.client + '/' + target.naics], risk: ['Live risk overlay for ' + target.client + '/' + target.geo] });
});

app.get('/engine/more-intel/:client/:agency/:naics/:geo/trends', async (req, res) => {
  const target = extractMoreIntelOverlay(req);
  const opportunities = (await loadLiveOpportunities()).filter((item) => matchesLiveTarget(item, target));
  const summary = summarizeOpportunities(opportunities);
  res.json({ opportunity: [opportunities.length + ' targeted live opportunities'], grant: ['Live grant trend for ' + target.client + '/' + target.naics], agency: topKeys(summary.agencyDistribution), spending: topKeys(summary.deadlineWindows) });
});

app.get('/engine/more-intel/:client/:agency/:naics/:geo/posture', async (req, res) => {
  const target = extractMoreIntelOverlay(req);
  const opportunities = (await loadLiveOpportunities()).filter((item) => matchesLiveTarget(item, target));
  res.json({ agency: opportunities.length ? 'Live agency posture: ' + target.agency : 'No live agency matches', modernization: 'Live modernization posture for ' + target.client + '/' + target.naics, compliance: 'Live compliance posture for ' + target.client + '/' + target.geo, risk: opportunities.length > 20 ? 'Monitor volume risk' : 'Low live-volume risk' });
});

app.get('/engine/more-intel/:client/:agency/:naics/:geo/blockers', async (req, res) => {
  const target = extractMoreIntelOverlay(req);
  const opportunities = (await loadLiveOpportunities()).filter((item) => matchesLiveTarget(item, target));
  res.json({ modernization: ['Review ' + opportunities.length + ' live opportunity records for modernization fit'], compliance: ['Compliance review for ' + target.client + '/' + target.agency], operational: ['Operational load: ' + opportunities.length + ' targeted records'], technical: ['Technical targeting: ' + target.client + '/' + target.agency + '/' + target.naics] });
});

app.get('/engine/more-intel/:client/:agency/:naics/:geo/forecasting', async (req, res) => {
  const target = extractMoreIntelOverlay(req);
  const opportunities = (await loadLiveOpportunities()).filter((item) => matchesLiveTarget(item, target));
  const grants = (await loadLiveGrants()).filter((item) => matchesLiveTarget(item, target));
  res.json({ signals: [opportunities.length + ' opportunity signals', grants.length + ' grant signals'], trends: ['Live trend window active'], spending: ['Live source mix: ' + opportunities.filter((item) => item.source === 'federal').length + ' federal / ' + opportunities.filter((item) => item.source === 'state').length + ' state'], outlook: opportunities.length || grants.length ? 'Live outlook active for ' + target.client : 'No live matches for selected overlay', unlock: (opportunities.length + grants.length) + ' live aligned items' });
});

app.get('/portfolio/more-intelligence', (req, res) => {
  const panel = (className, title) => '<section class="outer-block ' + className + '"><h3 class="panel-title">' + title + '</h3><div class="inner-frame"><p>Loading...</p></div></section>';
  const content = `
    <main class="dashboard-page more-intelligence-cockpit">
      <section class="outer-block header-block"><h3 class="panel-title">More Intelligence - Deep Multi-Axis Cockpit</h3><div class="inner-frame"><h2>Advanced Intelligence Signals</h2><p class="panel-desc">Blends Client x Agency x NAICS x Geo to produce deep advisory intelligence across five zones.</p></div></section>
      <section class="outer-block client-overlay"><h3 class="panel-title">Client Overlay</h3><div class="inner-frame"><select id="overlay-client" aria-label="Client Overlay"><option value="SYSTEM">System Intelligence</option><option value="A">Client A</option><option value="B">Client B</option><option value="C">Client C</option></select><div id="overlay-indicator">Overlay: SYSTEM</div></div></section>
      <section class="outer-block targeting-block"><h3 class="panel-title">Target Intelligence</h3><div class="inner-frame targeting-controls"><div class="target-control"><label for="target-agency">Agency</label><select id="target-agency"><option value="ALL">All Agencies</option><option value="VA">Veterans Affairs</option><option value="HHS">Health &amp; Human Services</option><option value="DOE">Department of Energy</option><option value="DOD">Department of Defense</option><option value="USDA">USDA</option></select></div><div class="target-control"><label for="target-naics">NAICS</label><select id="target-naics"><option value="ALL">All NAICS</option><option value="541512">541512 - IT Services</option><option value="541611">541611 - Management Consulting</option><option value="621111">621111 - Healthcare</option><option value="561320">561320 - Staffing</option></select></div><div class="target-control"><label for="target-geo">Geo</label><select id="target-geo"><option value="ALL">All Regions</option><option value="SW">Southwest</option><option value="MW">Midwest</option><option value="SE">Southeast</option><option value="PAC">Pacific</option><option value="NE">Northeast</option></select></div></div></section>
      <div class="cockpit-row">${panel('sig-opportunity', 'Opportunity Signals')}${panel('sig-grant', 'Grant Signals')}${panel('sig-modernization', 'Modernization Signals')}${panel('sig-risk', 'Risk Signals')}</div>
      <div class="cockpit-row">${panel('trend-opportunity', 'Opportunity Trends')}${panel('trend-grant', 'Grant Trends')}${panel('trend-agency', 'Agency Trends')}${panel('trend-spending', 'Spending Trends')}</div>
      <div class="cockpit-row">${panel('posture-agency', 'Agency Posture')}${panel('posture-modernization', 'Modernization Posture')}${panel('posture-compliance', 'Compliance Posture')}${panel('posture-risk', 'Risk Posture')}</div>
      <div class="cockpit-row">${panel('blockers-modernization', 'Modernization Blockers')}${panel('blockers-compliance', 'Compliance Blockers')}${panel('blockers-operational', 'Operational Blockers')}${panel('blockers-technical', 'Technical Blockers')}</div>
      <div class="cockpit-row">${panel('fc-signals', 'Forecast Signals')}${panel('fc-trends', 'Trend Lines')}${panel('fc-spending', 'Spending Patterns')}${panel('fc-outlook', 'Next Quarter Outlook')}${panel('fc-unlock', 'Unlock Forecast')}</div>
    </main>
    <script>
      (() => {
        let reloadVersion = 0;
        const load = async (endpoint) => {
          const response = await fetch(endpoint, { cache: 'no-store' });
          if (!response.ok) throw new Error('Deep intelligence unavailable');
          return response.json();
        };
        const setContent = (selector, value, version) => {
          if (version !== reloadVersion) return;
          const element = document.querySelector(selector + ' .inner-frame p');
          if (element) element.textContent = value;
        };
        const getOverlay = () => ({
          client: document.getElementById('overlay-client').value,
          agency: document.getElementById('target-agency').value,
          naics: document.getElementById('target-naics').value,
          geo: document.getElementById('target-geo').value,
        });
        const updateOverlayIndicator = () => {
          const overlay = getOverlay();
          document.getElementById('overlay-indicator').textContent = 'Overlay: ' + (overlay.client === 'SYSTEM' ? 'SYSTEM' : 'CLIENT-' + overlay.client);
        };
        const buildUrl = (type) => {
          const target = getOverlay();
          return '/engine/more-intel/' + encodeURIComponent(target.client) + '/' + encodeURIComponent(target.agency) + '/' + encodeURIComponent(target.naics) + '/' + encodeURIComponent(target.geo) + '/' + type;
        };
        async function loadMoreIntelModernization(clientId) {
          const results = await load('/engine/modernization/client/' + encodeURIComponent(clientId) + '/results');
          setContent('.posture-modernization', results.posture);
          setContent('.posture-compliance', results.compliance);
          setContent('.blockers-modernization', results.blockers.length + ' blockers');
        }
        async function loadMoreIntelRisk(clientId) {
          const results = await load('/engine/risk/client/' + encodeURIComponent(clientId) + '/results');
          setContent('.posture-risk', results.posture);
          setContent('.blockers-operational', 'Operational: ' + results.risks.operational);
          setContent('.blockers-technical', 'Technical: ' + results.risks.technical);
        }
        async function loadMoreIntelForecastingEngine(clientId) {
          const results = await load('/engine/forecast/client/' + encodeURIComponent(clientId) + '/results');
          setContent('.fc-signals', results.signals.length + ' signals');
          setContent('.fc-trends', results.trends.length + ' trends');
          setContent('.fc-spending', results.spending.join(', '));
          setContent('.fc-outlook', results.outlook);
          setContent('.fc-unlock', results.unlock);
        }
        async function loadMoreIntelSignals(version) {
          const signals = await load(buildUrl('signals'));
          setContent('.sig-opportunity', signals.opportunity[0], version); setContent('.sig-grant', signals.grant[0], version); setContent('.sig-modernization', signals.modernization[0], version); setContent('.sig-risk', signals.risk[0], version);
        }
        async function loadMoreIntelTrends(version) {
          const trends = await load(buildUrl('trends'));
          setContent('.trend-opportunity', trends.opportunity[0], version); setContent('.trend-grant', trends.grant[0], version); setContent('.trend-agency', trends.agency[0], version); setContent('.trend-spending', trends.spending[0], version);
        }
        async function loadMoreIntelPosture(version) {
          const posture = await load(buildUrl('posture'));
          setContent('.posture-agency', posture.agency, version); setContent('.posture-modernization', posture.modernization, version); setContent('.posture-compliance', posture.compliance, version); setContent('.posture-risk', posture.risk, version);
        }
        async function loadMoreIntelBlockers(version) {
          const blockers = await load(buildUrl('blockers'));
          setContent('.blockers-modernization', blockers.modernization[0], version); setContent('.blockers-compliance', blockers.compliance[0], version); setContent('.blockers-operational', blockers.operational[0], version); setContent('.blockers-technical', blockers.technical[0], version);
        }
        async function loadMoreIntelForecasting(version) {
          const forecasting = await load(buildUrl('forecasting'));
          setContent('.fc-signals', forecasting.signals[0], version); setContent('.fc-trends', forecasting.trends[0], version); setContent('.fc-spending', forecasting.spending[0], version); setContent('.fc-outlook', forecasting.outlook, version); setContent('.fc-unlock', forecasting.unlock, version);
        }
        const reloadAll = () => {
          const version = ++reloadVersion;
          updateOverlayIndicator();
          return Promise.all([loadMoreIntelSignals(version), loadMoreIntelTrends(version), loadMoreIntelPosture(version), loadMoreIntelBlockers(version), loadMoreIntelForecasting(version)]).catch(() => {
          if (version !== reloadVersion) return;
          document.querySelectorAll('.more-intelligence-cockpit .inner-frame p').forEach((element) => { element.textContent = 'Unavailable'; });
          });
        };
        ['overlay-client', 'target-agency', 'target-naics', 'target-geo'].forEach((id) => document.getElementById(id).addEventListener('change', reloadAll));
        reloadAll();
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER - Deep Intelligence', content, statusClass: 'system-row' }));
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

app.get('/client-dashboard-v3-legacy', (req, res) => {
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
          <div id="forecast-client" class="forecast-client-block">${activeClientId ? 'Loading readiness forecast...' : 'Readiness forecast will appear after a client context is selected.'}</div>
          <div id="client-readiness-narrative" class="forecast-narrative-block">Loading readiness narrative...</div>
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
        window.clientId = clientId;
        const setText = (id, text) => {
          const element = document.getElementById(id);
          if (element) element.textContent = text;
        };
        const setIndicator = (id, active) => {
          const element = document.getElementById(id);
          if (element) element.classList.toggle('indicator-active', active);
        };
        const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
        const renderClientForecast = (id, items) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = items && items.length
            ? items.slice(0, 5).map((item) => {
              const regime = String(item.regime || 'Stable').toLowerCase();
              const regimeClass = regime === 'uptrend' ? 'up' : regime === 'downtrend' ? 'down' : regime;
              const readiness = regime === 'uptrend' ? 'Likely Increase' : regime === 'downtrend' ? 'Likely Decrease' : regime === 'volatile' ? 'Volatile' : 'Stable';
              return '<div class="client-forecast-row"><strong>' + (item.stableAgency || item.stableNaics || 'Client-ready pipeline') + '</strong><span>' + (item.projected_30_day_opportunity_count || 0) + ' projected opportunities</span><span class="forecast-regime-' + regimeClass + '">' + readiness + '</span><span class="forecast-confidence">' + (item.confidence || 'Low') + ' confidence</span></div>';
            }).join('')
            : 'No client-context forecast data is available.';
        };
        async function loadClientForecast() {
          if (!window.clientId) return;
          try {
            const response = await fetch('/api/forecast/client/' + encodeURIComponent(window.clientId), { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderClientForecast('forecast-client', data.items || []);
          } catch (_) {
            setText('forecast-client', 'Readiness forecast unavailable.');
          }
        }
        const renderNarrative = (id, items) => {
          const element = document.getElementById(id);
          if (!element) return;
          element.innerHTML = items && items.length
            ? items.slice(0, 3).map((item) => '<div class="narrative-item">' + escapeHtml(item.summary || '') + '</div>').join('')
            : 'No readiness narrative data is available.';
        };
        async function loadClientReadinessNarrative() {
          try {
            const response = await fetch('/api/forecast/narrative/pipeline', { cache: 'no-store' });
            if (!response.ok) throw new Error('Request failed');
            const data = await response.json();
            renderNarrative('client-readiness-narrative', data.items || []);
          } catch (_) {
            setText('client-readiness-narrative', 'Readiness narrative unavailable.');
          }
        }
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

        loadClientReadinessNarrative();
        if (!clientId) return;
        fetch('/api/client/' + encodeURIComponent(clientId), { cache: 'no-store' })
          .then((response) => response.ok ? response.json() : Promise.reject())
          .then(renderClient)
          .catch(() => setText('client-info', 'Client profile unavailable.'));
        fetch('/api/client/intel/opportunities?client_id=' + encodeURIComponent(clientId) + '&view=deep', { cache: 'no-store' })
          .then((response) => response.ok ? response.json() : Promise.reject())
          .then(renderFeed)
          .catch(() => setText('intelligence-feed', 'Client intelligence feed unavailable.'));
        loadClientForecast();
      })();
    </script>
  `;
  res.send(htmlLayout({
    title: 'JE ROCKER LC - Client Dashboard',
    content,
    extraHead: '<link rel="stylesheet" href="/src/styles/client.css" />',
  }));
});

app.get('/client-dashboard', (req, res) => {
  const content = `
    <main class="dashboard-page client-dashboard-page">
      <div class="outer-block header-block"><h1 class="panel-title">CLIENT DASHBOARD</h1><div class="inner-frame"><h2>Client Intelligence Cockpit</h2></div></div>

      <div class="client-selector">
        <label for="clientDropdown">Select Client:</label>
        <select id="clientDropdown" onchange="loadClientData(this.value)">
          <option value="">Loading clients...</option>
        </select>
      </div>
      <section class="outer-block client-profile"><h3 class="panel-title">Client Profile</h3><div class="inner-frame"><p>Name: <span id="profile-client-name">--</span></p><p>NAICS: <span id="profile-client-naics">--</span></p><p>Agency Preferences: <span id="profile-client-agency">--</span></p><p>Geo: <span id="profile-client-geo">--</span></p><p>Keywords: <span id="profile-client-keywords">--</span></p><button type="button" id="add-client">Add New Client</button><button type="button" id="view-client-profile">View Profile</button><button type="button" id="view-client-intake">View Intake</button><button type="button" id="view-client-db">View Client DB</button></div></section>
      <section class="outer-block client-live-ingestion"><h3 class="panel-title">Client Ingestion</h3><div class="inner-frame"><input id="client-ingestion-id" type="text" placeholder="Numeric Client ID" aria-label="Numeric Client ID" /><button type="button" id="run-client-ingestion">Run Ingestion</button><p id="client-ingestion-status">Live client ingestion is idle.</p></div></section>

      <div class="cockpit-row snapshot-row">
        <section class="outer-block client-identity"><h3 class="panel-title">Client Identity</h3><div class="inner-frame"><p>Name: <span id="clientName">--</span></p><p>Tier: <span id="clientTier">--</span></p><p>Industry: <span id="clientIndustry">--</span></p><p>Region: <span id="clientRegion">--</span></p><p>Agency Alignment: <span id="clientAgency">--</span></p></div></section><section class="outer-block modernization-score"><h3 class="panel-title">Modernization Score</h3><div class="inner-frame"><p id="modernizationScore">--</p></div></section><section class="outer-block match-score"><h3 class="panel-title">Match Score</h3><div class="inner-frame"><p id="matchScore">--</p></div></section><section class="outer-block risk-score"><h3 class="panel-title">Risk Score</h3><div class="inner-frame"><p id="riskScore">--</p></div></section>
      </div>

      <div class="cockpit-row intelligence-row">
        <section class="outer-block compliance"><h3 class="panel-title">Compliance</h3><div class="inner-frame"><p>Placeholder</p></div></section><section class="outer-block modernization"><h3 class="panel-title">Modernization</h3><div class="inner-frame"><p>Placeholder</p></div></section><section class="outer-block forecasting"><h3 class="panel-title">Forecasting</h3><div class="inner-frame"><p>Placeholder</p></div></section><section class="outer-block opportunity-alignment"><h3 class="panel-title">Opportunity Alignment</h3><div class="inner-frame"><p>Placeholder</p></div></section><section class="outer-block readiness"><h3 class="panel-title">Readiness</h3><div class="inner-frame"><p>Placeholder</p></div></section><section class="outer-block momentum"><h3 class="panel-title">Momentum</h3><div class="inner-frame"><p>Placeholder</p></div></section>
      </div>

      <div class="cockpit-row opportunity-row">
        <section class="outer-block top-opportunities" data-type="alignment"><h3 class="panel-title">Top 10 Opportunities</h3><div class="inner-frame"><p class="top-opportunities-inner">Placeholder</p></div></section><section class="outer-block full-feed" data-type="full-opportunity-feed"><h3 class="panel-title">Full Opportunity Feed</h3><div class="inner-frame"><p>Placeholder</p></div></section><section class="outer-block agency-breakdown" data-type="agency-breakdown"><h3 class="panel-title">Agency Breakdown</h3><div class="inner-frame"><p>Placeholder</p></div></section><section class="outer-block submission-windows" data-type="submission-windows"><h3 class="panel-title">Submission Windows</h3><div class="inner-frame"><p>Placeholder</p></div></section>
      </div>

      <div class="cockpit-row action-row">
        <section class="outer-block action-box modernization-actions" data-type="action-modernization"><h3 class="panel-title">Modernization Actions</h3><div class="inner-frame"><p>Placeholder</p></div></section><section class="outer-block action-box compliance-actions" data-type="action-compliance"><h3 class="panel-title">Compliance Actions</h3><div class="inner-frame"><p>Placeholder</p></div></section><section class="outer-block action-box outreach-actions" data-type="action-outreach"><h3 class="panel-title">Outreach Actions</h3><div class="inner-frame"><p>Placeholder</p></div></section><section class="outer-block action-box checklist-notes" data-type="action-checklist"><h3 class="panel-title">Checklist / Notes</h3><div class="inner-frame"><p>Placeholder</p></div></section><section class="outer-block action-box submission-actions" data-type="action-submission"><h3 class="panel-title">Submission Actions</h3><div class="inner-frame"><p>Placeholder</p></div></section>
      </div>
      <section class="outer-block client-matches"><h3 class="panel-title">Matched Opportunities</h3><div class="inner-frame" id="client-matches-content"><p>Select a client to load matches.</p></div></section>
      <div class="cockpit-row client-modernization-row"><section class="outer-block posture-box client-modernization" data-type="posture-modernization"><h3 class="panel-title">Modernization Posture</h3><div class="inner-frame" id="client-modernization-content"><p>Select a client to load modernization.</p></div></section><section class="outer-block posture-box client-compliance" data-type="posture-compliance"><h3 class="panel-title">Compliance Posture</h3><div class="inner-frame" id="client-compliance-content"><p>Select a client to load compliance.</p></div></section><section class="outer-block client-blockers"><h3 class="panel-title">Modernization Blockers</h3><div class="inner-frame" id="client-blockers-content"><p>Select a client to load blockers.</p></div></section></div>
      <div class="cockpit-row client-risk-row"><section class="outer-block posture-box client-risk" data-type="posture-risk"><h3 class="panel-title">Risk Posture</h3><div class="inner-frame" id="client-risk-content"><p>Select a client to load risk.</p></div></section><section class="outer-block posture-box client-risk-breakdown" data-type="posture-risk"><h3 class="panel-title">Risk Breakdown</h3><div class="inner-frame" id="client-risk-breakdown-content"><p>Select a client to load risk.</p></div></section></div>
      <section class="outer-block client-forecast"><h3 class="panel-title">Forecast</h3><div class="inner-frame" id="client-forecast-content"><p>Select a client to load forecast.</p></div></section>
      <section class="outer-block client-priority-opps"><h3 class="panel-title">Top Opportunities</h3><div class="inner-frame" id="client-priority-opps-content"><p>Select a client to load priorities.</p></div></section>
    </main>
    <script>
      (() => {
        const normalizeClient = (client) => ({
          id: client.id || client.client_id,
          name: client.name || client.client_name || 'Unknown client',
          tier: client.tier || 'Active',
          industry: client.industry || client.naics || 'Not recorded',
          region: client.region || client.geo || 'Not recorded',
          agency: client.agency || client.agencyPref || client.preferred_agencies || 'Not recorded',
          keywords: client.keywords || '',
          scores: client.scores || { modernization: client.live_modernization_score || client.live_ingestion_score || 0, match: client.live_ingestion_score || 0, risk: client.live_risk_score || 0 },
          intelligence: client.intelligence || { compliance: client.live_compliance_score ? 'Score ' + client.live_compliance_score : 'Not run', forecasting: client.live_momentum_score ? 'Momentum ' + client.live_momentum_score : 'Not run' },
        });
        const loadEngineOutput = async (clientId, engine) => {
          const response = await fetch('/engine/client/' + encodeURIComponent(clientId) + '/' + engine, { cache: 'no-store' });
          if (!response.ok) throw new Error(engine + ' output unavailable');
          return response.json();
        };
        async function loadModernizationEngine(clientId) {
          const mod = await loadEngineOutput(clientId, 'modernization');
          document.querySelector('.modernization .inner-frame p').textContent = mod.posture + ' - Score ' + mod.score;
        }
        async function loadMatcherEngine(clientId) {
          const match = await loadEngineOutput(clientId, 'matcher');
          document.querySelector('.opportunity-alignment .inner-frame p').textContent = match.alignmentScore + ' - ' + match.alignedAgencies.length + ' agencies';
        }
        async function loadRiskEngine(clientId) {
          const risk = await loadEngineOutput(clientId, 'risk');
          document.querySelector('.risk-score .inner-frame p').textContent = risk.score + ' - ' + risk.level;
        }
        async function loadForecastingEngine(clientId) {
          const forecast = await loadEngineOutput(clientId, 'forecasting');
          document.querySelector('.momentum .inner-frame p').textContent = forecast.momentum + ' - ' + forecast.nextQuarter;
          document.querySelector('.readiness .inner-frame p').textContent = forecast.readiness;
        }
        async function loadEngineOpportunities(clientId) {
          const opportunities = await loadEngineOutput(clientId, 'opportunities');
          document.querySelector('.top-opportunities .inner-frame p').innerHTML = opportunities.top10.slice(0, 5).map((item) => '<span class="live-item-line">' + item.title + '</span>').join('') || 'No live opportunities';
          document.querySelector('.full-feed .inner-frame p').textContent = opportunities.fullFeed.length + ' items';
          document.querySelector('.agency-breakdown .inner-frame p').textContent = opportunities.agencies.length + ' agencies';
          document.querySelector('.submission-windows .inner-frame p').textContent = opportunities.windows.length + ' windows';
        }
        async function loadEngineActions(clientId) {
          const actions = await loadEngineOutput(clientId, 'actions');
          document.querySelector('.modernization-actions .inner-frame p').textContent = actions.modernization.length + ' items';
          document.querySelector('.compliance-actions .inner-frame p').textContent = actions.compliance.length + ' items';
          document.querySelector('.outreach-actions .inner-frame p').textContent = actions.outreach.length + ' items';
          document.querySelector('.submission-actions .inner-frame p').textContent = actions.submission.length + ' items';
          document.querySelector('.checklist-notes .inner-frame p').textContent = actions.notes.length + ' notes';
        }
        async function loadClientMatches(clientId) {
          const response = await fetch('/client/' + encodeURIComponent(clientId) + '/matched-opportunities', { cache: 'no-store' });
          if (!response.ok) return;
          const data = await response.json();
          const matches = data.matchedOpportunities || [];
          document.getElementById('client-matches-content').innerHTML = matches.length
            ? matches.map((match) => '<div class="match-item client-match-item">' + match.title + ' - ' + match.agency + ' (Score: ' + match.score + ')</div>').join('')
            : '<p>No matches available.</p>';
        }
        async function loadClientModernization(clientId) {
          const response = await fetch('/engine/modernization/client/' + encodeURIComponent(clientId) + '/results', { cache: 'no-store' });
          if (!response.ok) return;
          const data = await response.json();
          document.getElementById('client-modernization-content').textContent = data.posture;
          document.getElementById('client-compliance-content').textContent = data.compliance;
          document.getElementById('client-blockers-content').innerHTML = data.blockers.map((blocker) => '<div class="client-modernization-item">' + blocker + '</div>').join('');
        }
        async function loadClientRisk(clientId) {
          const response = await fetch('/engine/risk/client/' + encodeURIComponent(clientId) + '/results', { cache: 'no-store' });
          if (!response.ok) return;
          const data = await response.json();
          document.getElementById('client-risk-content').textContent = data.posture;
          document.getElementById('client-risk-breakdown-content').innerHTML = 'Compliance Risk: ' + data.risks.compliance + '<br>Operational Risk: ' + data.risks.operational + '<br>Technical Risk: ' + data.risks.technical;
        }
        async function loadClientForecast(clientId) {
          const response = await fetch('/engine/forecast/client/' + encodeURIComponent(clientId) + '/results', { cache: 'no-store' });
          if (!response.ok) return;
          const data = await response.json();
          document.getElementById('client-forecast-content').innerHTML = 'Outlook: ' + data.outlook + '<br>Signals: ' + data.signals.join(', ') + '<br>Trends: ' + data.trends.join(', ') + '<br>Spending: ' + data.spending.join(', ') + '<br>Unlock: ' + data.unlock;
        }
        async function loadClientPrioritization(clientId) {
          const response = await fetch('/engine/prioritize/client/' + encodeURIComponent(clientId) + '/results', { cache: 'no-store' });
          if (!response.ok) return;
          const data = await response.json();
          document.getElementById('client-priority-opps-content').innerHTML = data.opportunities.map((opportunity) => '<div class="client-priority-item">' + opportunity.title + ' - Score ' + opportunity.score + ' - ' + opportunity.source.toUpperCase() + '</div>').join('');
        }
        async function loadClientIngestionSummary(clientId) {
          const response = await fetch('/client/' + encodeURIComponent(clientId) + '/ingestion', { cache: 'no-store' });
          if (!response.ok) return;
          const summary = await response.json();
          document.getElementById('modernizationScore').textContent = summary.signals.modernization;
          document.getElementById('matchScore').textContent = summary.score;
          document.getElementById('riskScore').textContent = summary.signals.risk;
          document.querySelector('.readiness .inner-frame p').textContent = summary.signals.readiness;
          document.querySelector('.momentum .inner-frame p').textContent = summary.signals.momentum;
          document.querySelector('.compliance .inner-frame p').textContent = summary.signals.compliance;
          document.querySelector('.forecasting .inner-frame p').textContent = 'Score ' + summary.signals.momentum;
          document.getElementById('client-ingestion-status').textContent = summary.timestamp ? 'Last ingestion: ' + summary.timestamp : 'Live client ingestion has not run yet.';
        }
        const selectedClientId = () => document.getElementById('clientDropdown').value;
        async function loadClients() {
          const response = await fetch('/clients', { cache: 'no-store' });
          const data = await response.json();
          const dropdown = document.getElementById('clientDropdown');
          dropdown.innerHTML = '<option value="">Select Client</option>' + (data.clients || []).map((client) => '<option value="' + client.id + '">' + client.name + '</option>').join('');
        }
        document.getElementById('run-client-ingestion').addEventListener('click', async () => {
          const clientId = document.getElementById('client-ingestion-id').value.trim();
          const status = document.getElementById('client-ingestion-status');
          if (!clientId) { status.textContent = 'Enter a numeric client ID.'; return; }
          const response = await fetch('/engine/client-ingest/' + encodeURIComponent(clientId) + '/run', { method: 'POST' });
          const data = await response.json();
          status.textContent = response.ok ? 'Ingestion complete: ' + data.opportunities.length + ' opportunities, ' + data.grants.length + ' grants at ' + data.finishedAt : data.error || 'Ingestion failed.';
        });
        document.getElementById('view-client-profile').addEventListener('click', () => { const clientId = selectedClientId(); if (clientId) window.location.href = '/client/' + encodeURIComponent(clientId) + '/profile'; });
        document.getElementById('add-client').addEventListener('click', () => { window.location.href = '/client-intake'; });
        document.getElementById('view-client-intake').addEventListener('click', () => { const clientId = selectedClientId(); if (clientId) window.location.href = '/client/' + encodeURIComponent(clientId) + '/intake'; });
        document.getElementById('view-client-db').addEventListener('click', () => { window.location.href = '/clients/db'; });
        window.loadClientData = async (clientId) => {
          if (!clientId) return;
          window.activeClient = clientId;
          document.querySelectorAll('.client-dashboard-page .outer-block').forEach((block) => { block.dataset.clientId = clientId; });
          const response = await fetch('/api/client/' + encodeURIComponent(clientId), { cache: 'no-store' });
          if (!response.ok) return;
          const data = normalizeClient(await response.json());
          document.getElementById('client-ingestion-id').value = clientId;
          document.getElementById('clientName').innerHTML = '<a href="/client/' + encodeURIComponent(clientId) + '/profile">' + data.name + '</a>';
          document.getElementById('profile-client-name').innerHTML = '<a href="/client/' + encodeURIComponent(clientId) + '/profile">' + data.name + '</a>';
          document.getElementById('profile-client-naics').textContent = data.industry;
          document.getElementById('profile-client-agency').textContent = data.agency;
          document.getElementById('profile-client-geo').textContent = data.region;
          document.getElementById('profile-client-keywords').textContent = data.keywords || 'Not recorded';
          document.getElementById('clientTier').textContent = data.tier;
          document.getElementById('clientIndustry').textContent = data.industry;
          document.getElementById('clientRegion').textContent = data.region;
          document.getElementById('clientAgency').textContent = data.agency;
          document.getElementById('modernizationScore').textContent = data.scores.modernization;
          document.getElementById('matchScore').textContent = data.scores.match;
          document.getElementById('riskScore').textContent = data.scores.risk;
          document.querySelector('.compliance .inner-frame p').textContent = data.intelligence.compliance;
          document.querySelector('.forecasting .inner-frame p').textContent = data.intelligence.forecasting;
          await Promise.all([
            loadModernizationEngine(clientId),
            loadMatcherEngine(clientId),
            loadRiskEngine(clientId),
            loadForecastingEngine(clientId),
            loadEngineOpportunities(clientId),
            loadEngineActions(clientId),
            loadClientMatches(clientId),
            loadClientModernization(clientId),
            loadClientRisk(clientId),
            loadClientForecast(clientId),
            loadClientPrioritization(clientId),
          ]);
          await loadClientIngestionSummary(clientId);
          window.DashboardExplainability?.wireExplainability();
        };
        loadClients().catch(() => { document.getElementById('clientDropdown').innerHTML = '<option value="">Clients unavailable</option>'; });
      })();
    </script>
  `;
  res.send(htmlLayout({ title: 'JE ROCKER LC - Client Dashboard', content, statusClass: 'system-row' }));
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

const server = app.listen(PORT, () => {
  console.log(`Dashboard API running on http://localhost:${PORT}`);
});

const gneScheduler = startGneScheduler({ rootDir: __dirname, pythonBin: process.env.GNE_PYTHON_BIN });

for (const signalName of ['SIGINT', 'SIGTERM']) {
  process.once(signalName, () => {
    gneScheduler.stop();
    server.close(() => process.exit(0));
  });
}
