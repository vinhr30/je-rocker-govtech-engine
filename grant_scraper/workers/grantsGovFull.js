const { createWorker, asArray, firstDefined } = require('./baseWorker');
const { getSource } = require('../lib/registry');

const source = {
  ...getSource('grants_gov_full'),
  body: {
    rows: 100,
    keyword: '',
    oppStatuses: 'forecasted|posted',
  },
};

function parse(payload) {
  const hits = payload && payload.data ? payload.data.oppHits : null;
  return asArray(hits).map((record) => ({
    externalId: firstDefined(record, ['id', 'number']),
    url: record.id ? `https://www.grants.gov/search-results-detail/${record.id}` : null,
    record,
  }));
}

module.exports = createWorker(source, parse);
