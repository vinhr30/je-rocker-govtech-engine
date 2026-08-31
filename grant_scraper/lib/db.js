const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'grants.db');

function openDatabase(databasePath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  return new sqlite3.Database(databasePath);
}

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function allAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function getAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function closeAsync(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

async function columnNames(db, table) {
  const rows = await allAsync(db, `PRAGMA table_info(${table})`);
  return rows.map((row) => row.name);
}

async function addColumnIfMissing(db, table, column, definition) {
  const existing = await columnNames(db, table);
  if (!existing.includes(column)) {
    await runAsync(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureSchema(db) {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS grants_raw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      source_name TEXT,
      category TEXT,
      source_type TEXT NOT NULL DEFAULT 'single',
      ingestion_method TEXT NOT NULL DEFAULT 'api',
      external_id TEXT NOT NULL,
      source_url TEXT,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )
  `);
  await addColumnIfMissing(db, 'grants_raw', 'source_type', "TEXT NOT NULL DEFAULT 'single'");
  await addColumnIfMissing(db, 'grants_raw', 'ingestion_method', "TEXT NOT NULL DEFAULT 'api'");
  await runAsync(db, 'CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_raw_source_external ON grants_raw(source_id, external_id)');

  // grants_gov_full is detail-only now, so rows captured under the old search list shape are dropped.
  await runAsync(db, "DELETE FROM grants_raw WHERE source_id = 'grants_gov_full' AND source_type = 'single'");

  // The original table declared raw_id NOT NULL, which blocks list and detail rows; rebuild when seen.
  const normalizedInfo = await allAsync(db, 'PRAGMA table_info(grants_normalized)');
  if (normalizedInfo.some((column) => column.name === 'raw_id' && column.notnull === 1)) {
    await runAsync(db, 'DROP TABLE grants_normalized');
  }

  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS grants_normalized (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merge_key TEXT,
      list_raw_id INTEGER,
      detail_raw_id INTEGER,
      raw_id INTEGER,
      source_id TEXT NOT NULL,
      category TEXT,
      external_id TEXT,
      title TEXT,
      agency TEXT,
      agency_code TEXT,
      program TEXT,
      opportunity_number TEXT,
      status TEXT,
      posted_date TEXT,
      close_date TEXT,
      award_floor REAL,
      award_ceiling REAL,
      estimated_funding REAL,
      cfda_numbers TEXT,
      funding_instruments TEXT,
      applicant_types TEXT,
      attachments TEXT,
      related_opportunities TEXT,
      opportunity_category TEXT,
      url TEXT,
      description TEXT,
      normalized_at TEXT NOT NULL,
      detail_updated_at TEXT
    )
  `);

  for (const [column, definition] of [
    ['merge_key', 'TEXT'],
    ['list_raw_id', 'INTEGER'],
    ['detail_raw_id', 'INTEGER'],
    ['agency_code', 'TEXT'],
    ['estimated_funding', 'REAL'],
    ['cfda_numbers', 'TEXT'],
    ['funding_instruments', 'TEXT'],
    ['applicant_types', 'TEXT'],
    ['attachments', 'TEXT'],
    ['related_opportunities', 'TEXT'],
    ['opportunity_category', 'TEXT'],
    ['detail_updated_at', 'TEXT'],
  ]) {
    await addColumnIfMissing(db, 'grants_normalized', column, definition);
  }

  // Identity moved from raw_id to merge_key so list and detail layers collapse into one row.
  await runAsync(db, 'DELETE FROM grants_normalized WHERE merge_key IS NULL');
  await runAsync(db, 'DROP INDEX IF EXISTS ux_grants_normalized_raw');
  await runAsync(db, 'CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_normalized_merge ON grants_normalized(merge_key)');

  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS grant_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT,
      program TEXT,
      phase TEXT,
      topic_number TEXT,
      topic_title TEXT,
      topic_description TEXT,
      extracted_at TEXT NOT NULL,
      FOREIGN KEY (raw_id) REFERENCES grants_raw(id)
    )
  `);
  await runAsync(db, 'CREATE UNIQUE INDEX IF NOT EXISTS ux_grant_topics_raw_topic ON grant_topics(raw_id, topic_number)');
}

async function withDatabase(handler, databasePath) {
  const db = openDatabase(databasePath);
  try {
    await ensureSchema(db);
    return await handler(db);
  } finally {
    await closeAsync(db);
  }
}

module.exports = {
  DEFAULT_DB_PATH,
  allAsync,
  closeAsync,
  ensureSchema,
  getAsync,
  openDatabase,
  runAsync,
  withDatabase,
};
