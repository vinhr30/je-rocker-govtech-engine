const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DEFAULT_GRANTS_DB = path.join(__dirname, '..', '..', 'grant_scraper', 'data', 'grants.db');
const DEFAULT_CLIENT_DB = path.join(__dirname, '..', '..', 'client.db');

const LIST_COLUMNS = `
  opportunity_number, title, agency, status, posted_date, close_date,
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

const MATCH_THRESHOLD = 3;

/** Profile fields are free text, so both the full phrase and its words are matchable. */
function tokenize(value) {
  const phrases = new Set();
  const words = new Set();
  if (!value) return { phrases: [], words: [] };

  for (const part of String(value).split(/[,;|/\n]+/)) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed.length > 2) phrases.add(trimmed);
    for (const word of trimmed.split(/\s+/)) {
      if (word.length > 3 && !STOPWORDS.has(word)) words.add(word);
    }
  }
  return { phrases: [...phrases], words: [...words] };
}

function mergeTokens(...sets) {
  return {
    phrases: [...new Set(sets.flatMap((s) => s.phrases))],
    words: [...new Set(sets.flatMap((s) => s.words))],
  };
}

function haystack(...values) {
  return values.filter(Boolean).join(' ').toLowerCase();
}

function matchTokens(tokens, text, phraseWeight) {
  const phraseHits = tokens.phrases.filter((token) => text.includes(token));
  const wordHits = tokens.words.filter((token) => text.includes(token));
  return {
    hits: [...new Set([...phraseHits, ...wordHits])],
    score: phraseHits.length * phraseWeight + wordHits.length,
  };
}

/**
 * Scores a grant against a client profile on the three axes the dashboard
 * filters by. Returns the matched terms so the UI can explain the match.
 */
function scoreGrantForClient(grant, client) {
  if (!client) return { score: 0, matched: true, reasons: {} };

  const agencyTokens = mergeTokens(tokenize(client.agency), tokenize(client.preferred_agencies));
  const categoryTokens = mergeTokens(
    tokenize(client.capability_signals),
    tokenize(client.targeting_preferences),
    tokenize(client.keywords),
  );
  const eligibilityTokens = mergeTokens(
    tokenize(client.business_classifications),
    tokenize(client.business_size),
  );

  const agency = matchTokens(agencyTokens, haystack(grant.agency), 4);
  const category = matchTokens(
    categoryTokens,
    haystack(grant.title, grant.opportunity_category, grant.description),
    3,
  );
  const eligibility = matchTokens(eligibilityTokens, haystack(grant.applicant_types), 3);

  const score = agency.score + category.score + eligibility.score;

  return {
    score,
    matched: score >= MATCH_THRESHOLD,
    reasons: { agency: agency.hits, category: category.hits, eligibility: eligibility.hits },
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
    relevance: relevance ? { score: relevance.score, reasons: relevance.reasons } : null,
  };
}

async function getClientProfile(clientId, { clientDatabasePath = DEFAULT_CLIENT_DB } = {}) {
  if (!clientId) return null;
  const db = await openReadOnly(clientDatabasePath);
  try {
    return await getAsync(db, 'SELECT * FROM clients WHERE client_id = ?', [clientId]);
  } finally {
    await closeAsync(db);
  }
}

/** List layer: rows that came from the Simpler browser list worker. */
async function listGrants({
  limit = 50,
  offset = 0,
  clientId = null,
  databasePath = DEFAULT_GRANTS_DB,
  clientDatabasePath = DEFAULT_CLIENT_DB,
} = {}) {
  const client = await getClientProfile(clientId, { clientDatabasePath });
  const db = await openReadOnly(databasePath);

  try {
    const rows = await allAsync(
      db,
      `SELECT ${LIST_COLUMNS} FROM grants_normalized
       WHERE list_raw_id IS NOT NULL AND opportunity_number IS NOT NULL
       ORDER BY close_date IS NULL, close_date ASC`,
    );

    const scored = rows
      .map((row) => ({ row, relevance: scoreGrantForClient(row, client) }))
      .filter((entry) => entry.relevance.matched);

    if (client) scored.sort((a, b) => b.relevance.score - a.relevance.score);

    return {
      total: scored.length,
      unfilteredTotal: rows.length,
      limit,
      offset,
      clientId: client ? client.client_id : null,
      clientName: client ? client.client_name : null,
      grants: scored.slice(offset, offset + limit).map((entry) => toListItem(entry.row, client ? entry.relevance : null)),
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
  DEFAULT_CLIENT_DB,
  DEFAULT_GRANTS_DB,
  getGrantDetail,
  listGrants,
  scoreGrantForClient,
};
