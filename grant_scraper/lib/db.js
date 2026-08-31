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

async function ensureSchema(db) {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS grants_raw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      source_name TEXT,
      category TEXT,
      external_id TEXT NOT NULL,
      source_url TEXT,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )
  `);
  await runAsync(db, 'CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_raw_source_external ON grants_raw(source_id, external_id)');

  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS grants_normalized (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      category TEXT,
      external_id TEXT,
      title TEXT,
      agency TEXT,
      program TEXT,
      opportunity_number TEXT,
      status TEXT,
      posted_date TEXT,
      close_date TEXT,
      award_floor REAL,
      award_ceiling REAL,
      url TEXT,
      description TEXT,
      normalized_at TEXT NOT NULL,
      FOREIGN KEY (raw_id) REFERENCES grants_raw(id)
    )
  `);
  await runAsync(db, 'CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_normalized_raw ON grants_normalized(raw_id)');

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
