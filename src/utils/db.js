const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const clientEvents = new EventEmitter();

function openClientDb(databasePath = './client.db') {
  return new sqlite3.Database(databasePath);
}

function openOpportunitiesDb() {
  return new sqlite3.Database('./db/opportunities.db');
}

function openMatchesDb() {
  return new sqlite3.Database('./db/matches.db');
}

function allAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function getAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function closeAsync(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function getTableColumns(db, tableName) {
  try {
    const columns = await allAsync(db, `PRAGMA table_info(${tableName})`);
    return columns.map((col) => col.name);
  } catch {
    return [];
  }
}

function pickFirstAvailable(columns, candidates) {
  return candidates.find((name) => columns.includes(name)) || null;
}

async function ensureClientSchema(db) {
  await runAsync(
    db,
    `
    CREATE TABLE IF NOT EXISTS clients (
      client_id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT,
      uei TEXT,
      duns TEXT,
      naics TEXT,
      keywords TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      preferred_agencies TEXT,
      past_performance TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    `
  );

  const columns = await allAsync(db, 'PRAGMA table_info(clients)');
  const existing = new Set(columns.map((col) => col.name));
  const requiredColumns = [
    ['external_id', 'TEXT'],
    ['agency', 'TEXT'],
    ['capability_signals', 'TEXT'],
    ['targeting_preferences', 'TEXT'],
    ['lifecycle_status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['sam_registration', 'TEXT'],
    ['business_classifications', 'TEXT'],
    ['modernization_profile', 'TEXT'],
    ['business_size', 'TEXT'],
    ['procurement_history', 'TEXT'],
  ];

  for (const [name, type] of requiredColumns) {
    if (!existing.has(name)) {
      await runAsync(db, `ALTER TABLE clients ADD COLUMN ${name} ${type}`);
    }
  }
}

function toClientRow(row) {
  return {
    id: row.client_id || null,
    external_id: row.external_id || null,
    name: row.client_name || '',
    agency: row.agency || row.preferred_agencies || '',
    notes: row.notes || '',
    capability_signals: row.capability_signals || '',
    targeting_preferences: row.targeting_preferences || '',
    uei: row.uei || '',
    naics: row.naics || '',
    sam_registration: row.sam_registration || '',
    business_classifications: row.business_classifications || '',
    modernization_profile: row.modernization_profile || '',
    business_size: row.business_size || '',
    procurement_history: row.procurement_history || '',
    lifecycle_status: row.lifecycle_status || 'pending',
    created_at: row.created_at || null,
  };
}

async function createClient(input, databasePath) {
  const payload = {
    name: String(input?.name || '').trim(),
    agency: String(input?.agency || '').trim(),
    notes: String(input?.notes || '').trim(),
    capability_signals: String(input?.capability_signals || '').trim(),
    targeting_preferences: String(input?.targeting_preferences || '').trim(),
  };

  const db = openClientDb(databasePath);
  try {
    await ensureClientSchema(db);
    const result = await runAsync(
      db,
      `
      INSERT INTO clients (
        external_id,
        client_name,
        agency,
        preferred_agencies,
        notes,
        capability_signals,
        targeting_preferences,
        lifecycle_status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
      [
        null,
        payload.name,
        payload.agency,
        payload.agency,
        payload.notes,
        payload.capability_signals,
        payload.targeting_preferences,
        'pending',
      ]
    );

    const row = await getAsync(
      db,
      `
      SELECT
        client_id,
        external_id,
        client_name,
        agency,
        preferred_agencies,
        notes,
        capability_signals,
        targeting_preferences,
        lifecycle_status,
        created_at
      FROM clients
      WHERE client_id = ?
      `,
      [result.lastID]
    );

    const client = toClientRow(row || {});
    clientEvents.emit('onClientCreated', client);
    return client;
  } finally {
    await closeAsync(db);
  }
}

const addClient = createClient;

async function getClientById(clientId, databasePath) {
  const normalizedClientId = Number(clientId);
  if (!Number.isInteger(normalizedClientId) || normalizedClientId <= 0) {
    throw new TypeError('A valid clientId is required');
  }

  const db = openClientDb(databasePath);
  try {
    await ensureClientSchema(db);
    const row = await getAsync(db, 'SELECT * FROM clients WHERE client_id = ?', [normalizedClientId]);
    return row ? toClientRow(row) : null;
  } finally {
    await closeAsync(db);
  }
}

async function getClients() {
  const db = openClientDb();
  try {
    await ensureClientSchema(db);
    const rows = await allAsync(
      db,
      `
      SELECT
        client_id,
        external_id,
        client_name,
        agency,
        preferred_agencies,
        notes,
        capability_signals,
        targeting_preferences,
        created_at
      FROM clients
      ORDER BY client_id DESC
      `
    );

    return rows.map(toClientRow);
  } catch {
    return [];
  } finally {
    await closeAsync(db);
  }
}

async function getMostRecentClient() {
  const db = openClientDb();
  try {
    await ensureClientSchema(db);
    const row = await getAsync(
      db,
      `
      SELECT
        client_id,
        external_id,
        client_name,
        agency,
        preferred_agencies,
        notes,
        capability_signals,
        targeting_preferences,
        created_at
      FROM clients
      ORDER BY datetime(created_at) DESC, client_id DESC
      LIMIT 1
      `
    );

    return row ? toClientRow(row) : null;
  } catch {
    return null;
  } finally {
    await closeAsync(db);
  }
}

async function getClientCount() {
  const db = openClientDb();
  try {
    await ensureClientSchema(db);
    const row = await getAsync(db, 'SELECT COUNT(*) AS count FROM clients');
    return Number(row?.count || 0);
  } catch {
    return 0;
  } finally {
    await closeAsync(db);
  }
}

async function ensureJeRockerClient() {
  return new Promise((resolve, reject) => {
    const db = openClientDb();
    ensureClientSchema(db)
      .then(() => getAsync(db, 'SELECT client_id FROM clients WHERE external_id = ? OR client_name = ?', ['je-rocker', 'JE ROCKER LC']))
      .then((existing) => {
        if (existing?.client_id) {
          return null;
        }

        return runAsync(
          db,
          `
          INSERT INTO clients (
            external_id,
            client_name,
            agency,
            preferred_agencies,
            notes,
            capability_signals,
            targeting_preferences,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `,
          [
            'je-rocker',
            'JE ROCKER LC',
            'Multiple Agencies',
            'Multiple Agencies',
            'Founder-owned GovTech development client.',
            'GovTech ingestion, AI pipelines, federal contracting readiness.',
            'Federal agencies with recurring procurement cycles.',
          ]
        );
      })
      .then(() => closeAsync(db))
      .then(resolve)
      .catch((error) => {
        closeAsync(db)
          .catch(() => null)
          .finally(() => reject(error));
      });
  });
}

async function getLastScraperRun() {
  const db = openOpportunitiesDb();
  try {
    const columns = await getTableColumns(db, 'opportunities');
    const timeColumn = pickFirstAvailable(columns, ['updated_at', 'updated', 'scraped_at', 'created_at', 'response_date']);
    if (!timeColumn) return null;

    const row = await getAsync(db, `SELECT MAX(${timeColumn}) AS value FROM opportunities`);
    return row?.value || null;
  } catch {
    return null;
  } finally {
    await closeAsync(db).catch(() => null);
  }
}

async function getLastMatcherRun() {
  const db = openMatchesDb();
  try {
    const matchColumns = await getTableColumns(db, 'matches');
    const matchTimeColumn = pickFirstAvailable(matchColumns, ['timestamp', 'updated_at', 'created_at']);

    if (matchTimeColumn) {
      const row = await getAsync(db, `SELECT MAX(${matchTimeColumn}) AS value FROM matches`);
      if (row?.value) return row.value;
    }

    const reviewColumns = await getTableColumns(db, 'matches_low_confidence');
    const reviewTimeColumn = pickFirstAvailable(reviewColumns, ['timestamp', 'updated_at', 'created_at']);

    if (!reviewTimeColumn) return null;
    const reviewRow = await getAsync(db, `SELECT MAX(${reviewTimeColumn}) AS value FROM matches_low_confidence`);
    return reviewRow?.value || null;
  } catch {
    return null;
  } finally {
    await closeAsync(db).catch(() => null);
  }
}

async function getOpportunityCount() {
  const db = openOpportunitiesDb();
  try {
    const row = await getAsync(db, 'SELECT COUNT(*) AS count FROM opportunities');
    return Number(row?.count || 0);
  } catch {
    return 0;
  } finally {
    await closeAsync(db).catch(() => null);
  }
}

function readLogFile(candidates) {
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (!fs.existsSync(resolved)) continue;
      return fs.readFileSync(resolved, 'utf8');
    } catch {
      continue;
    }
  }
  return null;
}

function readScraperLog() {
  return readLogFile([
    './utils/logs/scraper.log',
    './utils/logs/scraper_engine.log',
    './utils/logs/scraper_run.log',
  ]);
}

function readMatcherLog() {
  return readLogFile([
    './utils/logs/matcher.log',
    './utils/logs/match_engine.log',
  ]);
}

module.exports = {
  ensureClientSchema,
  ensureJeRockerClient,
  clientEvents,
  createClient,
  addClient,
  getClientById,
  getClients,
  getMostRecentClient,
  getClientCount,
  getLastScraperRun,
  getLastMatcherRun,
  getOpportunityCount,
  readScraperLog,
  readMatcherLog,
};
