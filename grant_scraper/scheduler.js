const { withDatabase } = require('./lib/db');
const { listWorkers } = require('./workers');
const { runNormalization } = require('./pipeline/normalize');
const { runTopicExtraction } = require('./pipeline/topics');

/**
 * Cadence policy required by the engine spec:
 *   - Grants.gov: daily
 *   - SBIR/STTR:  weekly
 *   - States:     daily
 */
const SCHEDULE = Object.freeze({
  daily: Object.freeze(['grants_gov', 'state']),
  weekly: Object.freeze(['sbir']),
});

function getScheduledWorkers(cadence) {
  if (!SCHEDULE[cadence]) {
    throw new Error(`Unknown cadence: ${cadence}. Expected one of ${Object.keys(SCHEDULE).join(', ')}`);
  }
  return listWorkers({ cadence });
}

async function runWorkers(db, workers, { fetchImpl, env, now } = {}) {
  const results = [];
  const failures = [];

  for (const worker of workers) {
    try {
      results.push(await worker.run({ db, fetchImpl, env, now }));
    } catch (error) {
      failures.push({ sourceId: worker.id, error: error.message });
    }
  }

  return { results, failures };
}

/** Runs one cadence end to end: ingest -> normalize -> extract topics. */
async function runCadence(cadence, { databasePath, fetchImpl, env, now } = {}) {
  const workers = getScheduledWorkers(cadence);

  return withDatabase(async (db) => {
    const ingestion = await runWorkers(db, workers, { fetchImpl, env, now });
    const normalization = await runNormalization(db, { now });
    const topics = cadence === 'weekly'
      ? await runTopicExtraction(db, { now })
      : { solicitations: 0, written: 0, failures: [] };

    return {
      cadence,
      sources: workers.map((worker) => worker.id),
      ingestion,
      normalization,
      topics,
    };
  }, databasePath);
}

async function runAll(options = {}) {
  const daily = await runCadence('daily', options);
  const weekly = await runCadence('weekly', options);
  return { daily, weekly };
}

module.exports = {
  SCHEDULE,
  getScheduledWorkers,
  runAll,
  runCadence,
  runWorkers,
};
