const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DEFAULT_GRANTS_DB = path.join(__dirname, '..', '..', 'grant_scraper', 'data', 'grants.db');
const DEFAULT_COMPANY_DB = path.join(__dirname, '..', '..', 'company.db');
const DEFAULT_BUSINESS_DRIVER_DB = path.join(__dirname, '..', '..', 'business_driver.db');
const COMPANY_ID = 'jerocker';

const WEIGHTS = Object.freeze({
  agency: 4,
  businessDriver: 4,
  capabilities: 3,
  focusAreas: 3,
  modernization: 2,
});

const LIST_COLUMNS = `
  opportunity_number, title, agency, agency_code, status, posted_date, close_date,
  award_floor, award_ceiling, url, opportunity_category, applicant_types, description
`;

function openReadOnly(databasePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, (err) =>
      err ? reject(err) : resolve(db),
    );
  });
}

function allAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function getAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function closeAsync(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

// Words common to almost every federal notice carry no signal about fit.
const STOPWORDS = new Set([
  'and', 'the', 'for', 'inc', 'llc', 'corp', 'company', 'group', 'other',
  'department', 'program', 'programs', 'services', 'service', 'office', 'national',
  'federal', 'grant', 'grants', 'support', 'general', 'public', 'united', 'states',
  'agency', 'administration', 'bureau', 'center', 'management',
]);

/**
 * Multi-word profile entries only match as a whole phrase; splitting them would
 * let a term like "data ingestion pipelines" match on the word "data" alone.
 */
function tokenize(value) {
  const phrases = new Set();
  const words = new Set();
  if (!value) return { phrases: [], words: [] };

  const parts = Array.isArray(value) ? value : String(value).split(/[,;|\n]+/);
  for (const part of parts) {
    const trimmed = String(part).trim().toLowerCase();
    if (trimmed.length < 3) continue;

    const segments = trimmed.split(/[\s/]+/).filter(Boolean);
    if (segments.length > 1) {
      phrases.add(trimmed);
    } else if (!STOPWORDS.has(trimmed)) {
      words.add(trimmed);
    }
  }
  return { phrases: [...phrases], words: [...words] };
}

function haystack(...values) {
  return values.filter(Boolean).join(' ').toLowerCase();
}

// Synopsis text arrives as HTML; tags would otherwise split phrases apart.
function stripMarkup(value) {
  return value ? String(value).replace(/<[^>]+>/g, ' ') : '';
}

/**
 * Text a grant is matched against. `description` holds the Grants.gov synopsis,
 * and `synopsis` is accepted too so either shape scores identically.
 */
function subjectText(grant) {
  return haystack(
    grant.title,
    grant.opportunity_category,
    stripMarkup(grant.description),
    stripMarkup(grant.synopsis),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-token matching keeps short agency codes like DOT and DOE out of ordinary words.
function containsToken(text, token) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`, 'i').test(text);
}

function matchTokens(tokens, text, weight) {
  const hits = [...tokens.phrases, ...tokens.words].filter((token) => containsToken(text, token));
  const unique = [...new Set(hits)];
  return { hits: unique, score: unique.length * weight };
}

/**
 * Scores a grant against the JE ROCKER LC profile and its signal sets. Every
 * grant keeps a score so the list can be ranked rather than filtered, and each
 * axis is reported separately so the UI can explain the ranking.
 */
/**
 * Claims tokens for the first axis that asks for them. Axes are evaluated in
 * descending weight order, so a term shared by two axes scores once, at the
 * higher weight, instead of being counted on both.
 */
function claimTokens(tokens, claimed) {
  const phrases = tokens.phrases.filter((token) => !claimed.has(token));
  const words = tokens.words.filter((token) => !claimed.has(token));
  for (const token of [...phrases, ...words]) claimed.add(token);
  return { phrases, words };
}

function scoreGrantForCompany(grant, profile, signals = {}) {
  const empty = {
    score: 0,
    score_agency: 0,
    score_capabilities: 0,
    score_focus_areas: 0,
    score_modernization: 0,
    score_business_driver: 0,
    score_total: 0,
    reasons: {},
  };
  if (!profile) return empty;

  const subject = subjectText(grant);
  const agencyText = haystack(grant.agency, grant.agency_code);

  // Agency matches a different haystack, so it never competes for these tokens.
  const agency = matchTokens(tokenize(profile.preferred_agencies), agencyText, WEIGHTS.agency);

  const claimed = new Set();
  // driver_map widens each driver with the wording grant notices actually use.
  const driverTokens = claimTokens(
    tokenize([...(signals.businessDrivers || []), ...(signals.driverMapTerms || [])]),
    claimed,
  );
  // capability_map widens each capability with related wording at the same weight.
  const capabilityTokens = claimTokens(
    tokenize([...(profile.capabilities || []), ...(signals.capabilityMapTerms || [])]),
    claimed,
  );
  const focusTokens = claimTokens(tokenize(profile.focus_areas), claimed);
  const modernizationTokens = claimTokens(tokenize(profile.modernization_signals), claimed);

  const businessDriver = matchTokens(driverTokens, subject, WEIGHTS.businessDriver);
  const capabilities = matchTokens(capabilityTokens, subject, WEIGHTS.capabilities);
  const focusAreas = matchTokens(focusTokens, subject, WEIGHTS.focusAreas);
  const modernization = matchTokens(modernizationTokens, subject, WEIGHTS.modernization);

  const total =
    agency.score + businessDriver.score + capabilities.score + focusAreas.score + modernization.score;

  return {
    score: total,
    score_agency: agency.score,
    score_capabilities: capabilities.score,
    score_focus_areas: focusAreas.score,
    score_modernization: modernization.score,
    score_business_driver: businessDriver.score,
    score_total: total,
    reasons: {
      agency: agency.hits,
      businessDrivers: businessDriver.hits,
      capabilities: capabilities.hits,
      focusAreas: focusAreas.hits,
      modernizationSignals: modernization.hits,
    },
  };
}

function toListItem(row, relevance) {
  return {
    oppNum: row.opportunity_number,
    title: row.title,
    agency: row.agency,
    deadline: row.close_date,
    status: row.status,
    awardMin: row.award_floor,
    awardMax: row.award_ceiling,
    postedDate: row.posted_date,
    url: row.url,
    href: `/grant/${encodeURIComponent(row.opportunity_number)}`,
    relevance: relevance
      ? {
        score: relevance.score_total,
        score_agency: relevance.score_agency,
        score_capabilities: relevance.score_capabilities,
        score_focus_areas: relevance.score_focus_areas,
        score_modernization: relevance.score_modernization,
        score_business_driver: relevance.score_business_driver,
        score_total: relevance.score_total,
        reasons: relevance.reasons,
      }
      : null,
  };
}

function parseList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value).split(/[,;|\n]+/).map((v) => v.trim()).filter(Boolean);
  }
}

async function getCompanyProfile({ companyDatabasePath = DEFAULT_COMPANY_DB, companyId = COMPANY_ID } = {}) {
  let db;
  try {
    db = await openReadOnly(companyDatabasePath);
  } catch {
    return null;
  }

  try {
    const row = await getAsync(db, 'SELECT * FROM company_profile WHERE id = ?', [companyId]);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      capabilities: parseList(row.capabilities),
      focus_areas: parseList(row.focus_areas),
      preferred_agencies: parseList(row.preferred_agencies),
      modernization_signals: parseList(row.modernization_signals),
    };
  } catch {
    return null;
  } finally {
    await closeAsync(db);
  }
}

/** Signal sets are optional; a missing database simply contributes no score. */
async function getSignalSets({ businessDriverDatabasePath = DEFAULT_BUSINESS_DRIVER_DB, companyId = COMPANY_ID } = {}) {
  const empty = { businessDrivers: [], capabilityMapTerms: [], driverMapTerms: [] };
  let db;
  try {
    db = await openReadOnly(businessDriverDatabasePath);
  } catch {
    return empty;
  }

  const readTerms = async (sql) => {
    try {
      return await allAsync(db, sql, [companyId]);
    } catch {
      return [];
    }
  };

  try {
    const drivers = await readTerms('SELECT driver FROM business_drivers WHERE company_id = ?');
    const mapped = await readTerms('SELECT mapped_term FROM capability_map WHERE company_id = ?');
    const driverMapped = await readTerms('SELECT mapped_term FROM driver_map WHERE company_id = ?');
    return {
      businessDrivers: drivers.map((row) => row.driver),
      capabilityMapTerms: mapped.map((row) => row.mapped_term),
      driverMapTerms: driverMapped.map((row) => row.mapped_term),
    };
  } catch {
    return empty;
  } finally {
    await closeAsync(db);
  }
}

/** List layer: rows that came from the Simpler browser list worker. */
async function listGrants({
  limit = 50,
  offset = 0,
  databasePath = DEFAULT_GRANTS_DB,
  companyDatabasePath = DEFAULT_COMPANY_DB,
  businessDriverDatabasePath = DEFAULT_BUSINESS_DRIVER_DB,
} = {}) {
  const profile = await getCompanyProfile({ companyDatabasePath });
  const signals = await getSignalSets({ businessDriverDatabasePath });
  const db = await openReadOnly(databasePath);

  try {
    const rows = await allAsync(
      db,
      `SELECT ${LIST_COLUMNS} FROM grants_normalized
       WHERE list_raw_id IS NOT NULL AND opportunity_number IS NOT NULL
       ORDER BY close_date IS NULL, close_date ASC`,
    );

    // Every grant is returned; the profile only changes the ordering.
    const ranked = rows.map((row) => ({ row, relevance: scoreGrantForCompany(row, profile, signals) }));
    if (profile) ranked.sort((a, b) => b.relevance.score_total - a.relevance.score_total);

    return {
      total: ranked.length,
      ranked: Boolean(profile),
      limit,
      offset,
      company: profile ? { id: profile.id, name: profile.name, type: profile.type } : null,
      grants: ranked.slice(offset, offset + limit).map((entry) => toListItem(entry.row, profile ? entry.relevance : null)),
    };
  } finally {
    await closeAsync(db);
  }
}

/** Cross-signal breakdown for one grant, used by the "why this matches" view. */
async function getGrantSignals(oppNum, {
  databasePath = DEFAULT_GRANTS_DB,
  companyDatabasePath = DEFAULT_COMPANY_DB,
  businessDriverDatabasePath = DEFAULT_BUSINESS_DRIVER_DB,
} = {}) {
  const profile = await getCompanyProfile({ companyDatabasePath });
  const signals = await getSignalSets({ businessDriverDatabasePath });
  const db = await openReadOnly(databasePath);

  try {
    const row = await getAsync(
      db,
      `SELECT ${LIST_COLUMNS} FROM grants_normalized WHERE opportunity_number = ? LIMIT 1`,
      [oppNum],
    );
    if (!row) return null;

    const relevance = scoreGrantForCompany(row, profile, signals);
    return {
      oppNum: row.opportunity_number,
      title: row.title,
      company: profile ? { id: profile.id, name: profile.name } : null,
      scores: {
        score_agency: relevance.score_agency,
        score_capabilities: relevance.score_capabilities,
        score_focus_areas: relevance.score_focus_areas,
        score_modernization: relevance.score_modernization,
        score_business_driver: relevance.score_business_driver,
        score_total: relevance.score_total,
      },
      weights: WEIGHTS,
      signals: [
        { key: 'agency', label: 'Preferred agency', weight: WEIGHTS.agency, score: relevance.score_agency, matches: relevance.reasons.agency || [] },
        { key: 'business_driver', label: 'Business driver', weight: WEIGHTS.businessDriver, score: relevance.score_business_driver, matches: relevance.reasons.businessDrivers || [] },
        { key: 'capabilities', label: 'Capabilities', weight: WEIGHTS.capabilities, score: relevance.score_capabilities, matches: relevance.reasons.capabilities || [] },
        { key: 'focus_areas', label: 'Focus areas', weight: WEIGHTS.focusAreas, score: relevance.score_focus_areas, matches: relevance.reasons.focusAreas || [] },
        { key: 'modernization', label: 'Modernization signals', weight: WEIGHTS.modernization, score: relevance.score_modernization, matches: relevance.reasons.modernizationSignals || [] },
      ],
    };
  } finally {
    await closeAsync(db);
  }
}

function parseJsonColumn(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Detail layer: deep metadata sourced from the Grants.gov fetchOpportunity endpoint. */
async function getGrantDetail(oppNum, { databasePath = DEFAULT_GRANTS_DB } = {}) {
  const db = await openReadOnly(databasePath);
  try {
    const row = await getAsync(
      db,
      'SELECT * FROM grants_normalized WHERE opportunity_number = ? LIMIT 1',
      [oppNum],
    );
    if (!row) return null;

    return {
      oppNum: row.opportunity_number,
      title: row.title,
      agency: row.agency,
      agencyCode: row.agency_code,
      status: row.status,
      postedDate: row.posted_date,
      deadline: row.close_date,
      url: row.url,
      hasDetail: row.detail_raw_id !== null,
      synopsis: row.description,
      applicantTypes: row.applicant_types,
      opportunityCategory: row.opportunity_category,
      cfda: row.cfda_numbers,
      fundingRange: {
        awardFloor: row.award_floor,
        awardCeiling: row.award_ceiling,
        estimatedFunding: row.estimated_funding,
      },
      fundingInstruments: row.funding_instruments,
      attachments: parseJsonColumn(row.attachments),
      relatedOpportunities: parseJsonColumn(row.related_opportunities),
      detailUpdatedAt: row.detail_updated_at,
    };
  } finally {
    await closeAsync(db);
  }
}

module.exports = {
  COMPANY_ID,
  DEFAULT_BUSINESS_DRIVER_DB,
  DEFAULT_COMPANY_DB,
  DEFAULT_GRANTS_DB,
  WEIGHTS,
  getCompanyProfile,
  getGrantDetail,
  getGrantSignals,
  getSignalSets,
  listGrants,
  scoreGrantForCompany,
  subjectText,
};
