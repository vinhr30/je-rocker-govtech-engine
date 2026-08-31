const { createWorker, asArray, firstDefined } = require('./baseWorker');
const { getSource } = require('../lib/registry');

const source = {
  ...getSource('grants_gov_simpler'),
  body: {
    filters: { opportunity_status: { one_of: ['posted', 'forecasted'] } },
    pagination: {
      page_offset: 1,
      page_size: 100,
      sort_order: [{ order_by: 'post_date', sort_direction: 'descending' }],
    },
  },
};

function parse(payload) {
  return asArray(payload && payload.data).map((record) => ({
    externalId: firstDefined(record, ['opportunity_id', 'opportunity_number', 'legacy_opportunity_id']),
    url: record.opportunity_number
      ? `https://simpler.grants.gov/opportunity/${record.opportunity_id || record.opportunity_number}`
      : null,
    record,
  }));
}

module.exports = createWorker(source, parse);
