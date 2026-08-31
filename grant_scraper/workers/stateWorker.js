const { createWorker, asArray, firstDefined } = require('./baseWorker');
const { getSource } = require('../lib/registry');

const ARRAY_PATHS = [
  (p) => (Array.isArray(p) ? p : null),
  (p) => (p && p.result ? p.result.records : null),
  (p) => (p ? p.records : null),
  (p) => (p ? p.opportunities : null),
  (p) => (p ? p.results : null),
  (p) => (p ? p.data : null),
];

const ID_KEYS = ['_id', 'id', 'grant_id', 'GrantID', 'opportunity_id', 'PortalID', 'OpportunityNumber', 'Title', 'title'];
const URL_KEYS = ['GrantURL', 'url', 'link', 'Link', 'opportunity_url', 'ApplicationURL'];

/**
 * State grant portals differ in envelope shape, so the parser probes the
 * common JSON containers and falls back to the first array it finds.
 */
function extractRecords(payload) {
  for (const path of ARRAY_PATHS) {
    const candidate = path(payload);
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function createStateWorker(sourceId) {
  const source = getSource(sourceId);

  function parse(payload) {
    return asArray(extractRecords(payload)).map((record) => ({
      externalId: firstDefined(record, ID_KEYS),
      url: firstDefined(record, URL_KEYS),
      record,
    }));
  }

  return createWorker(source, parse);
}

module.exports = { createStateWorker, extractRecords };
