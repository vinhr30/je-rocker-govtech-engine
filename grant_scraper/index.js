const { DEFAULT_DB_PATH, allAsync, ensureSchema, getAsync, openDatabase, withDatabase } = require('./lib/db');
const { listSources, getSource, registry } = require('./lib/registry');
const { getWorker, listWorkers, WORKERS } = require('./workers');
const { runNormalization } = require('./pipeline/normalize');
const { runTopicExtraction } = require('./pipeline/topics');
const { SCHEDULE, runAll, runCadence, runWorkers } = require('./scheduler');

/** Runs a single named source end to end. Useful for verifying one endpoint. */
async function runSource(sourceId, { databasePath, fetchImpl, now } = {}) {
  const worker = getWorker(sourceId);
  return withDatabase(async (db) => {
    const ingestion = await worker.run({ db, fetchImpl, now });
    const normalization = await runNormalization(db, { sourceId, now });
    const topics = worker.source.category === 'sbir'
      ? await runTopicExtraction(db, { sourceId, now })
      : { solicitations: 0, written: 0, failures: [] };
    return { ingestion, normalization, topics };
  }, databasePath);
}

async function getIngestionStats({ databasePath } = {}) {
  return withDatabase(async (db) => {
    const counts = await Promise.all([
      getAsync(db, 'SELECT COUNT(*) AS n FROM grants_raw'),
      getAsync(db, 'SELECT COUNT(*) AS n FROM grants_normalized'),
      getAsync(db, 'SELECT COUNT(*) AS n FROM grant_topics'),
    ]);
    const bySource = await allAsync(db, 'SELECT source_id, COUNT(*) AS n FROM grants_raw GROUP BY source_id ORDER BY source_id');
    return {
      grants_raw: counts[0].n,
      grants_normalized: counts[1].n,
      grant_topics: counts[2].n,
      bySource,
    };
  }, databasePath);
}

module.exports = {
  DEFAULT_DB_PATH,
  SCHEDULE,
  WORKERS,
  ensureSchema,
  getIngestionStats,
  getSource,
  getWorker,
  listSources,
  listWorkers,
  openDatabase,
  registry,
  runAll,
  runCadence,
  runNormalization,
  runSource,
  runTopicExtraction,
  runWorkers,
  withDatabase,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
  };

  const source = getArg('--source');
  const cadence = getArg('--cadence');

  const task = source
    ? runSource(source)
    : cadence
      ? runCadence(cadence)
      : args.includes('--stats')
        ? getIngestionStats()
        : runAll();

  task
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
