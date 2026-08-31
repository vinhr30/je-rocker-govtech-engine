const WORKERS = [
  require('./grantsGovSimpler'),
  require('./grantsGovFull'),
  require('./dodSbir'),
  require('./nsfSbir'),
  require('./nihSbir'),
  require('./doeSbir'),
  require('./nasaSbir'),
  require('./usdaSbir'),
  require('./dhsSbir'),
  require('./dotSbir'),
  require('./arizona'),
  require('./california'),
  require('./florida'),
  require('./virginia'),
];

const WORKERS_BY_ID = new Map(WORKERS.map((worker) => [worker.id, worker]));

function getWorker(sourceId) {
  const worker = WORKERS_BY_ID.get(sourceId);
  if (!worker) throw new Error(`No worker registered for source: ${sourceId}`);
  return worker;
}

function listWorkers({ cadence, category } = {}) {
  return WORKERS.filter((worker) => {
    if (worker.source.enabled === false) return false;
    if (cadence && worker.source.cadence !== cadence) return false;
    if (category && worker.source.category !== category) return false;
    return true;
  });
}

module.exports = {
  WORKERS,
  getWorker,
  listWorkers,
};
