const { createWorker, asArray, firstDefined } = require('./baseWorker');
const { getSource } = require('../lib/registry');

/**
 * All SBIR/STTR agencies are served by the same sbir.gov solicitations API,
 * so they share one parser and differ only by the registry entry.
 */
function createSbirWorker(sourceId) {
  const source = getSource(sourceId);

  function parse(payload) {
    const records = Array.isArray(payload) ? payload : asArray(payload && payload.results);
    return records.map((record) => ({
      externalId: firstDefined(record, ['solicitation_id', 'solicitation_number', 'solicitation_title']),
      url: firstDefined(record, ['solicitation_agency_url', 'sbir_solicitation_link', 'solicitation_link']),
      record,
    }));
  }

  return createWorker(source, parse);
}

module.exports = { createSbirWorker };
