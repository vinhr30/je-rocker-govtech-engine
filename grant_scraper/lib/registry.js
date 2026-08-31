const registry = require('../sources/registry.json');

const CADENCES = Object.freeze(['daily', 'weekly']);
const CATEGORIES = Object.freeze(['grants_gov', 'sbir', 'state']);

function listSources({ cadence, category, includeDisabled = false } = {}) {
  return registry.filter((source) => {
    if (!includeDisabled && source.enabled === false) return false;
    if (cadence && source.cadence !== cadence) return false;
    if (category && source.category !== category) return false;
    return true;
  });
}

function getSource(sourceId) {
  const source = registry.find((entry) => entry.id === sourceId);
  if (!source) throw new Error(`Unknown grant source: ${sourceId}`);
  return source;
}

module.exports = {
  CADENCES,
  CATEGORIES,
  getSource,
  listSources,
  registry,
};
