const { createWorker, asArray } = require('./baseWorker');
const { getSource } = require('../lib/registry');

const SEARCH_PARAM = {
  searchText: null,
  components: null,
  programYear: null,
  solicitationCycleNames: ['openTopics'],
  releaseNumbers: [],
  topicReleaseStatus: [591],
  modernizationPriorities: [],
  sortBy: null,
  technologyAreaIds: [],
  component: null,
  program: null,
};

const base = getSource('dod_sbir');
const source = {
  ...base,
  endpoint: `${base.endpoint}?searchParam=${encodeURIComponent(JSON.stringify(SEARCH_PARAM))}&size=200&page=0`,
};

function parse(payload) {
  return asArray(payload && payload.data).map((record) => ({
    externalId: String(record.topicCode || record.topicId),
    url: record.topicId ? `https://www.dodsbirsttr.mil/topics-app/?topicId=${record.topicId}` : null,
    record,
  }));
}

module.exports = createWorker(source, parse);
