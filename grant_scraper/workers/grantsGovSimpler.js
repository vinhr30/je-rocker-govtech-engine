const { createWorker, asArray, firstDefined } = require('./baseWorker');
const { getSource } = require('../lib/registry');

const PAGE_SIZE = 100;

const source = {
  ...getSource('grants_gov_simpler'),
  body: {
    filters: { opportunity_status: { one_of: ['posted', 'forecasted'] } },
    pagination: {
      page_offset: 1,
      page_size: PAGE_SIZE,
      sort_order: [{ order_by: 'post_date', sort_direction: 'descending' }],
    },
  },
};

/** Detail lookups need the Grants.gov legacy id, so it is preserved on every list record. */
function parse(payload) {
  return asArray(payload && payload.data).map((record) => {
    const summary = record.summary || {};
    const legacyId = firstDefined(record, ['legacy_opportunity_id', 'opportunity_id']);
    return {
      externalId: firstDefined(record, ['opportunity_id', 'opportunity_number']),
      url: record.opportunity_id ? `https://simpler.grants.gov/opportunity/${record.opportunity_id}` : null,
      record: {
        ...record,
        legacy_opportunity_id: legacyId,
        opportunity_number: record.opportunity_number || null,
        post_date: summary.post_date || record.post_date || null,
        close_date: summary.close_date || record.close_date || null,
      },
    };
  });
}

module.exports = createWorker(source, parse);
