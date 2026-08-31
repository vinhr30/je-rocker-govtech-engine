const { allAsync, runAsync } = require('../lib/db');

const BROWSER_LIST_SOURCE = 'simpler_browser';
const API_LIST_SOURCE = 'grants_gov_simpler';
const FEDERAL_LIST_SOURCES = new Set([BROWSER_LIST_SOURCE, API_LIST_SOURCE]);
const FEDERAL_DETAIL_SOURCE = 'grants_gov_full';

// Simpler owns list fields outright; Grants.gov detail only fills gaps in them.
const UPSERT_LIST = `
  INSERT INTO grants_normalized (
    merge_key, list_raw_id, source_id, category, external_id, title, agency,
    program, opportunity_number, status, posted_date, close_date, url, normalized_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(merge_key) DO UPDATE SET
    list_raw_id = excluded.list_raw_id,
    external_id = excluded.external_id,
    title = excluded.title,
    agency = excluded.agency,
    program = excluded.program,
    opportunity_number = excluded.opportunity_number,
    status = excluded.status,
    posted_date = excluded.posted_date,
    close_date = excluded.close_date,
    url = COALESCE(excluded.url, grants_normalized.url),
    normalized_at = excluded.normalized_at
`;

const UPSERT_DETAIL = `
  INSERT INTO grants_normalized (
    merge_key, detail_raw_id, source_id, category, opportunity_number, title, agency,
    agency_code, award_floor, award_ceiling, estimated_funding, cfda_numbers,
    funding_instruments, applicant_types, attachments, related_opportunities,
    opportunity_category, url, description, normalized_at, detail_updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(merge_key) DO UPDATE SET
    detail_raw_id = excluded.detail_raw_id,
    opportunity_number = COALESCE(grants_normalized.opportunity_number, excluded.opportunity_number),
    title = COALESCE(grants_normalized.title, excluded.title),
    agency = COALESCE(grants_normalized.agency, excluded.agency),
    agency_code = excluded.agency_code,
    award_floor = excluded.award_floor,
    award_ceiling = excluded.award_ceiling,
    estimated_funding = excluded.estimated_funding,
    cfda_numbers = excluded.cfda_numbers,
    funding_instruments = excluded.funding_instruments,
    applicant_types = excluded.applicant_types,
    attachments = excluded.attachments,
    related_opportunities = excluded.related_opportunities,
    opportunity_category = excluded.opportunity_category,
    url = COALESCE(grants_normalized.url, excluded.url),
    description = excluded.description,
    detail_updated_at = excluded.detail_updated_at
`;

const UPSERT_SINGLE = `
  INSERT INTO grants_normalized (
    merge_key, raw_id, source_id, category, external_id, title, agency, program,
    opportunity_number, status, posted_date, close_date,
    award_floor, award_ceiling, url, description, normalized_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(merge_key) DO UPDATE SET
    raw_id = excluded.raw_id,
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

/** Grants.gov nests live detail under `synopsis` and pre-publication detail under `forecast`. */
function mapFullDetail(detail) {
  const body = detail.synopsis || detail.forecast || {};
  const cfdas = (detail.cfdas || []).map((entry) => entry.cfdaNumber).filter(Boolean);
  const attachments = (detail.synopsisAttachmentFolders || []).flatMap((folder) =>
    (folder.synopsisAttachments || []).map((file) => ({
      id: file.id,
      name: file.fileName,
      description: file.fileDescription,
      mimeType: file.mimeType,
    })),
  );

  return {
    opportunityNumber: pick(detail, ['opportunityNumber']),
    title: pick(detail, ['opportunityTitle']),
    agency: detail.agencyDetails ? detail.agencyDetails.agencyName : null,
    agencyCode: pick(detail, ['owningAgencyCode']) || (detail.agencyDetails ? detail.agencyDetails.agencyCode : null),
    awardFloor: pick(body, ['awardFloor']),
    awardCeiling: pick(body, ['awardCeiling']),
    estimatedFunding: pick(body, ['estimatedFunding']),
    cfdaNumbers: cfdas.length ? cfdas.join(', ') : null,
    fundingInstruments: (body.fundingInstruments || []).map((i) => i.description).join(', ') || null,
    applicantTypes: (body.applicantTypes || []).map((i) => i.description).join(', ') || null,
    attachments: attachments.length ? JSON.stringify(attachments) : null,
    relatedOpportunities: (detail.relatedOpps || []).length ? JSON.stringify(detail.relatedOpps) : null,
    opportunityCategory: detail.opportunityCategory ? detail.opportunityCategory.description : null,
    description: pick(body, ['synopsisDesc', 'forecastDesc']),
    detailUpdatedAt: pick(body, ['lastUpdatedDate', 'createdDate']),
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

/** Federal list and detail rows share one merged row keyed by opportunity number. */
function mergeKeyFor(row, record) {
  if (FEDERAL_LIST_SOURCES.has(row.source_id) || row.source_id === FEDERAL_DETAIL_SOURCE) {
    const number = record.opportunity_number || record.opportunityNumber;
    if (!number) return null;
    return `FED:${String(number).trim().toUpperCase()}`;
  }
  return `${row.source_id}:${row.external_id}`;
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

/** DOM-extracted list rows already use normalized field names. */
function mapSimplerBrowser(record) {
  return {
    title: pick(record, ['title']),
    agency: pick(record, ['agency']),
    program: pick(record, ['category']),
    opportunityNumber: pick(record, ['opportunityNumber']),
    status: pick(record, ['status']),
    postedDate: pick(record, ['postedDate']),
    closeDate: pick(record, ['deadline']),
  };
}

async function writeListRow(db, row, record, mergeKey, normalizedAt) {
  const mapped = row.source_id === BROWSER_LIST_SOURCE ? mapSimplerBrowser(record) : mapGrantsGovSimpler(record);
  await runAsync(db, UPSERT_LIST, [
    mergeKey, row.id, row.source_id, row.category, row.external_id,
    toText(mapped.title), toText(mapped.agency), toText(mapped.program),
    toText(mapped.opportunityNumber), toText(mapped.status),
    toIsoDate(mapped.postedDate), toIsoDate(mapped.closeDate),
    row.source_url || null, normalizedAt,
  ]);
}

async function writeDetailRow(db, row, record, mergeKey, normalizedAt) {
  const d = mapFullDetail(record);
  await runAsync(db, UPSERT_DETAIL, [
    mergeKey, row.id, row.source_id, row.category, toText(d.opportunityNumber),
    toText(d.title), toText(d.agency), toText(d.agencyCode),
    toNumber(d.awardFloor), toNumber(d.awardCeiling), toNumber(d.estimatedFunding),
    d.cfdaNumbers, d.fundingInstruments, d.applicantTypes, d.attachments,
    d.relatedOpportunities, d.opportunityCategory,
    row.source_url || null, toText(d.description), normalizedAt, toText(d.detailUpdatedAt),
  ]);
}

async function writeSingleRow(db, row, mergeKey, normalizedAt) {
  const v = normalizeRow(row);
  await runAsync(db, UPSERT_SINGLE, [
    mergeKey, v.rawId, v.sourceId, v.category, v.externalId, v.title, v.agency,
    v.program, v.opportunityNumber, v.status, v.postedDate, v.closeDate,
    v.awardFloor, v.awardCeiling, v.url, v.description, normalizedAt,
  ]);
}

/**
 * Reads rows from grants_raw and writes merged records into grants_normalized.
 * Simpler supplies list fields, Grants.gov detail supplies deep metadata, and
 * the two are joined on opportunity number.
 */
async function runNormalization(db, { sourceId, reprocess = false, now = () => new Date().toISOString() } = {}) {
  const conditions = [];
  const params = [];
  if (!reprocess) {
    conditions.push(
      '(r.id NOT IN (SELECT list_raw_id FROM grants_normalized WHERE list_raw_id IS NOT NULL) AND ' +
        'r.id NOT IN (SELECT detail_raw_id FROM grants_normalized WHERE detail_raw_id IS NOT NULL) AND ' +
        'r.id NOT IN (SELECT raw_id FROM grants_normalized WHERE raw_id IS NOT NULL))',
    );
  }
  if (sourceId) {
    conditions.push('r.source_id = ?');
    params.push(sourceId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // List rows first so detail COALESCE never overwrites authoritative list fields,
  // and the browser list source last so it wins over the API list source.
  const rows = await allAsync(
    db,
    `SELECT r.* FROM grants_raw r ${where} ORDER BY CASE r.source_type WHEN 'list' THEN 0 WHEN 'single' THEN 1 ELSE 2 END, CASE r.source_id WHEN '${BROWSER_LIST_SOURCE}' THEN 1 ELSE 0 END, r.id ASC`,
    params,
  );

  const normalizedAt = now();
  const failures = [];
  const skipped = [];
  let written = 0;

  for (const row of rows) {
    try {
      const record = JSON.parse(row.raw_json);
      const mergeKey = mergeKeyFor(row, record);
      if (!mergeKey) {
        skipped.push({ rawId: row.id, sourceId: row.source_id, reason: 'missing opportunity number' });
        continue;
      }

      if (FEDERAL_LIST_SOURCES.has(row.source_id)) await writeListRow(db, row, record, mergeKey, normalizedAt);
      else if (row.source_id === FEDERAL_DETAIL_SOURCE) await writeDetailRow(db, row, record, mergeKey, normalizedAt);
      else await writeSingleRow(db, row, mergeKey, normalizedAt);

      written += 1;
    } catch (error) {
      failures.push({ rawId: row.id, sourceId: row.source_id, error: error.message });
    }
  }

  return {
    candidates: rows.length,
    written,
    skipped: skipped.length,
    skippedSample: skipped.slice(0, 3),
    failures,
  };
}

module.exports = {
  mapFullDetail,
  mergeKeyFor,
  normalizeRow,
  runNormalization,
  toIsoDate,
  toNumber,
};
