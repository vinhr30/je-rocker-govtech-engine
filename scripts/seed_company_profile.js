const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DEFAULT_COMPANY_DB = path.join(__dirname, '..', 'company.db');

const JE_ROCKER = {
  id: 'jerocker',
  name: 'JE ROCKER LC',
  type: 'primary_contractor',
  capabilities: [
    'govtech modernization',
    'federal procurement intelligence',
    'scraping engines',
    'multi-engine architecture',
    'data ingestion pipelines',
    'dashboard intelligence',
    'forecasting engines',
    'scenario modeling',
    'cluster computing',
    'LLM/ML fusion',
    'SBIR alignment',
    'DARPA alignment',
    'compliance automation',
  ],
  focus_areas: [
    'digital modernization',
    'federal IT transformation',
    'AI/ML applied research',
    'data systems',
    'public sector analytics',
    'procurement automation',
  ],
  preferred_agencies: ['DoD', 'DARPA', 'USDA', 'DOE', 'NSF', 'DHS', 'DOT', 'NIH', 'NASA'],
  modernization_signals: [
    'legacy system replacement',
    'data interoperability',
    'dashboard modernization',
    'AI-driven analytics',
    'automation',
    'federal digital transformation',
  ],
};

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

async function seedCompanyProfile(databasePath = DEFAULT_COMPANY_DB, profile = JE_ROCKER) {
  const db = new sqlite3.Database(databasePath);

  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS company_profile (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      focus_areas TEXT NOT NULL,
      preferred_agencies TEXT NOT NULL,
      modernization_signals TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await runAsync(
    db,
    `INSERT INTO company_profile (id, name, type, capabilities, focus_areas, preferred_agencies, modernization_signals, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       type = excluded.type,
       capabilities = excluded.capabilities,
       focus_areas = excluded.focus_areas,
       preferred_agencies = excluded.preferred_agencies,
       modernization_signals = excluded.modernization_signals,
       updated_at = excluded.updated_at`,
    [
      profile.id,
      profile.name,
      profile.type,
      JSON.stringify(profile.capabilities),
      JSON.stringify(profile.focus_areas),
      JSON.stringify(profile.preferred_agencies),
      JSON.stringify(profile.modernization_signals),
      new Date().toISOString(),
    ],
  );

  await new Promise((resolve) => db.close(resolve));
  return profile.id;
}

module.exports = { DEFAULT_COMPANY_DB, JE_ROCKER, seedCompanyProfile };

if (require.main === module) {
  seedCompanyProfile()
    .then((id) => console.log(`Seeded company profile: ${id}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
