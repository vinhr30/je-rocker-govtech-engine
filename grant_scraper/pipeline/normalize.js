const { allAsync, runAsync } = require('../lib/db');

const INSERT_NORMALIZED = `
  INSERT INTO grants_normalized (
    raw_id, source_id, category, external_id, title, agency, program,
    opportunity_number, status, posted_date, close_date,
    award_floor, award_ceiling, url, description, normalized_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(raw_id) DO UPDATE SET
    title = excluded.title,
    agency = excluded.agency,
    program = excluded.program,
    opportunity_number = excluded.opportunity_number,
    status = excluded.status,
    posted_date = excluded.posted_date,
    close_date = excluded.close_date,
    award_floor = excluded.award_floor,
    award_ceiling = excluded.award_ceiling,
    url = excluded.url,
    description = excluded.description,
    normalized_at = excluded.normalized_at
`;

function pick(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

function toText(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Accepts ISO strings, epoch milliseconds, and the MM/DD/YYYY form used by Grants.gov. */
function toIsoDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString().slice(0, 10);
  }
  const text = toText(value);
  if (!text) return null;
  if (/^\d{12,}$/.test(text)) return new Date(Number(text)).toISOString().slice(0, 10);
  const usFormat = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (usFormat) {
    const year = usFormat[3].length === 2 ? `20${usFormat[3]}` : usFormat[3];
    return `${year}-${usFormat[1].padStart(2, '0')}-${usFormat[2].padStart(2, '0')}`;
  }
  const isoPrefix = text.match(/^\d{4}-\d{2}-\d{2}/);
  return isoPrefix ? isoPrefix[0] : text;
}

function mapGrantsGovSimpler(record) {
  const summary = record.summary || {};
  return {
    title: pick(record, ['opportunity_title']),
    agency: pick(record, ['agency_name', 'agency', 'agency_code']),
    program: pick(record, ['category', 'funding_category']),
    opportunityNumber: pick(record, ['opportunity_number']),
    status: pick(record, ['opportunity_status']),
    postedDate: pick({ ...summary, ...record }, ['post_date', 'posted_date']),
    closeDate: pick({ ...summary, ...record }, ['close_date']),
    awardFloor: pick({ ...summary, ...record }, ['award_floor']),
    awardCeiling: pick({ ...summary, ...record }, ['award_ceiling']),
    description: pick({ ...summary, ...record }, ['summary_description', 'description']),
  };
}

function mapGrantsGovFull(record) {
  return {
    title: pick(record, ['title']),
    agency: pick(record, ['agency', 'agencyName', 'agencyCode']),
    program: pick(record, ['docType', 'cfdaList']),
    opportunityNumber: pick(record, ['number']),
    status: pick(record, ['oppStatus']),
    postedDate: pick(record, ['openDate', 'postedDate']),
    closeDate: pick(record, ['closeDate']),
    awardFloor: pick(record, ['awardFloor']),
    awardCeiling: pick(record, ['awardCeiling']),
    description: pick(record, ['description', 'synopsis']),
  };
}

function mapSbir(record) {
  return {
    title: pick(record, ['solicitation_title', 'title']),
    agency: pick(record, ['agency', 'solicitation_agency']),
    program: pick(record, ['program', 'phase']),
    opportunityNumber: pick(record, ['solicitation_number']),
    status: pick(record, ['current_status', 'status']),
    postedDate: pick(record, ['open_date', 'release_date']),
    closeDate: pick(record, ['close_date']),
    awardFloor: pick(record, ['award_floor']),
    awardCeiling: pick(record, ['award_ceiling', 'phase_i_award_amount']),
    description: pick(record, ['description', 'solicitation_description']),
  };
}

function mapDodTopic(record) {
  return {
    title: pick(record, ['topicTitle']),
    agency: pick(record, ['component', 'command']) || 'Department of Defense',
    program: pick(record, ['program']),
    opportunityNumber: pick(record, ['topicCode', 'solicitationNumber']),
    status: pick(record, ['topicStatus']),
    postedDate: pick(record, ['topicStartDate', 'topicPreReleaseStartDate']),
    closeDate: pick(record, ['topicEndDate']),
    awardFloor: null,
    awardCeiling: null,
    description: pick(record, ['solicitationTitle', 'cycleName']),
  };
}

function mapNasaSolicitation(record) {
  return {
    title: pick(record, ['Opportunity']),
    agency: 'NASA',
    program: pick(record, ['program']),
    opportunityNumber: null,
    status: null,
    postedDate: pick(record, ['Open Date']),
    closeDate: pick(record, ['Close Date']),
    awardFloor: null,
    awardCeiling: null,
    description: pick(record, ['Selection Announcement'])
      ? `Selection announcement: ${pick(record, ['Selection Announcement'])}`
      : null,
  };
}

/** Grants.gov docType says "forecast"/"synopsis", so the SBIR vs STTR program is read from the notice text. */
function mapGrantsGovSbir(record) {
  const mapped = mapGrantsGovFull(record);
  const haystack = `${record.title || ''} ${record.number || ''}`.toUpperCase();
  return { ...mapped, program: haystack.includes('STTR') ? 'STTR' : 'SBIR' };
}

function mapState(record) {
  return {
    title: pick(record, ['Title', 'title', 'GrantTitle', 'name', 'opportunity_title']),
    agency: pick(record, ['AgencyDept', 'Agency', 'agency', 'department', 'AgencyName']),
    program: pick(record, ['Categories', 'category', 'program', 'Type']),
    opportunityNumber: pick(record, ['OpportunityNumber', 'GrantID', 'grant_id', 'PortalID']),
    status: pick(record, ['Status', 'status']),
    postedDate: pick(record, ['OpenDate', 'open_date', 'PostedDate', 'posted_date', 'ApplicationDeadlineOpen']),
    closeDate: pick(record, ['ApplicationDeadline', 'CloseDate', 'close_date', 'deadline']),
    awardFloor: pick(record, ['EstAmounts', 'award_floor', 'AwardFloor']),
    awardCeiling: pick(record, ['AwardCeiling', 'award_ceiling', 'EstAvailFunds']),
    description: pick(record, ['Purpose', 'Description', 'description', 'summary']),
  };
}

const MAPPERS = {
  grants_gov_simpler: mapGrantsGovSimpler,
  grants_gov_full: mapGrantsGovFull,
  dod_sbir: mapDodTopic,
  nasa_sbir: mapNasaSolicitation,
  nsf_sbir: mapGrantsGovSbir,
  nih_sbir: mapGrantsGovSbir,
  doe_sbir: mapGrantsGovSbir,
  usda_sbir: mapGrantsGovSbir,
  dhs_sbir: mapGrantsGovSbir,
  dot_sbir: mapGrantsGovSbir,
};

function selectMapper(row) {
  if (MAPPERS[row.source_id]) return MAPPERS[row.source_id];
  if (row.category === 'sbir') return mapSbir;
  if (row.category === 'state') return mapState;
  return mapState;
}

function normalizeRow(row) {
  const record = JSON.parse(row.raw_json);
  const mapped = selectMapper(row)(record);
  return {
    rawId: row.id,
    sourceId: row.source_id,
    category: row.category,
    externalId: row.external_id,
    title: toText(mapped.title),
    agency: toText(mapped.agency),
    program: toText(mapped.program),
    opportunityNumber: toText(mapped.opportunityNumber),
    status: toText(mapped.status),
    postedDate: toIsoDate(mapped.postedDate),
    closeDate: toIsoDate(mapped.closeDate),
    awardFloor: toNumber(mapped.awardFloor),
    awardCeiling: toNumber(mapped.awardCeiling),
    url: row.source_url || null,
    description: toText(mapped.description),
  };
}

/**
 * Reads pending rows from grants_raw and writes normalized records into
 * grants_normalized. Pass reprocess:true to rebuild every row.
 */
async function runNormalization(db, { sourceId, reprocess = false, now = () => new Date().toISOString() } = {}) {
  const conditions = [];
  const params = [];
  if (!reprocess) {
    conditions.push('r.id NOT IN (SELECT raw_id FROM grants_normalized)');
  }
  if (sourceId) {
    conditions.push('r.source_id = ?');
    params.push(sourceId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await allAsync(db, `SELECT r.* FROM grants_raw r ${where} ORDER BY r.id ASC`, params);

  const normalizedAt = now();
  const failures = [];
  let written = 0;

  for (const row of rows) {
    try {
      const value = normalizeRow(row);
      await runAsync(db, INSERT_NORMALIZED, [
        value.rawId, value.sourceId, value.category, value.externalId, value.title,
        value.agency, value.program, value.opportunityNumber, value.status,
        value.postedDate, value.closeDate, value.awardFloor, value.awardCeiling,
        value.url, value.description, normalizedAt,
      ]);
      written += 1;
    } catch (error) {
      failures.push({ rawId: row.id, sourceId: row.source_id, error: error.message });
    }
  }

  return { candidates: rows.length, written, failures };
}

module.exports = {
  normalizeRow,
  runNormalization,
  toIsoDate,
  toNumber,
};
