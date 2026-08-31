const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DEFAULT_BUSINESS_DRIVER_DB = path.join(__dirname, '..', 'business_driver.db');
const COMPANY_ID = 'jerocker';

const JE_ROCKER_DRIVERS = [
  'reduce legacy system risk',
  'accelerate digital modernization',
  'improve data interoperability',
  'increase procurement transparency',
  'deploy AI-driven analytics',
  'replace manual workflows with automation',
  'modernize public sector dashboards',
  'strengthen compliance and reporting',
  'enable real-time operational visibility',
  'support multi-agency data sharing',
  'advance mission-critical decision support',
  'reduce technical debt in federal systems',
];

const JE_ROCKER_CAPABILITY_MAP = {
  'govtech modernization': [
    'digital transformation', 'public sector modernization',
    'government IT modernization', 'federal digital services',
  ],
  'federal procurement intelligence': [
    'opportunity analysis', 'grant intelligence', 'contract forecasting', 'procurement analytics',
  ],
  'scraping engines': [
    'data extraction', 'web harvesting', 'automated data collection', 'structured data ingestion',
  ],
  'multi-engine architecture': [
    'modular system design', 'pipeline orchestration', 'distributed processing', 'engine-based architecture',
  ],
  'data ingestion pipelines': [
    'etl pipeline', 'data integration', 'extract transform load', 'data onboarding',
  ],
  'dashboard intelligence': [
    'decision support dashboard', 'executive reporting', 'operational dashboards', 'mission analytics',
  ],
  'forecasting engines': [
    'predictive modeling', 'trend analysis', 'scenario forecasting', 'market regime analysis',
  ],
  'scenario modeling': [
    'what-if analysis', 'simulation modeling', 'risk scenario planning', 'contingency modeling',
  ],
  'cluster computing': [
    'distributed compute', 'parallel processing', 'multi-node systems', 'compute clusters',
  ],
  'LLM/ML fusion': [
    'machine learning', 'ai modeling', 'language model integration', 'ml pipelines',
  ],
  'SBIR alignment': [
    'small business innovation research', 'phase i research', 'phase ii development', 'federal innovation programs',
  ],
  'DARPA alignment': [
    'advanced research', 'high-risk high-reward', 'defense innovation', 'emerging technology research',
  ],
  'compliance automation': [
    'regulatory automation', 'policy compliance', 'audit automation', 'reporting automation',
  ],
};

const JE_ROCKER_DRIVER_MAP = {
  'reduce legacy system risk': [
    'legacy system replacement', 'modernize legacy systems', 'legacy modernization', 'system modernization',
  ],
  'accelerate digital modernization': [
    'digital transformation', 'modernize digital infrastructure', 'it modernization', 'technology modernization',
  ],
  'improve data interoperability': [
    'interoperability', 'data sharing', 'data exchange', 'cross-agency data integration',
  ],
  'increase procurement transparency': [
    'procurement modernization', 'acquisition transparency', 'contracting data visibility', 'procurement analytics',
  ],
  'deploy AI-driven decision support': [
    'ai-driven analytics', 'machine learning', 'predictive analytics', 'decision support systems',
  ],
  'replace manual workflows with automation': [
    'workflow automation', 'process automation', 'automated systems', 'digital workflow modernization',
  ],
  'modernize public sector dashboards': [
    'dashboard modernization', 'real-time dashboards', 'executive reporting', 'mission analytics dashboards',
  ],
  'strengthen compliance and reporting': [
    'compliance automation', 'audit automation', 'regulatory reporting', 'policy compliance',
  ],
  'enable real-time operational visibility': [
    'real-time analytics', 'operational dashboards', 'situational awareness', 'mission-critical visibility',
  ],
  'support multi-agency data sharing': [
    'interagency data sharing', 'federated data systems', 'cross-agency interoperability', 'shared data infrastructure',
  ],
  'advance mission-critical decision support': [
    'mission analytics', 'decision support systems', 'operational decision support', 'strategic decision support',
  ],
  'reduce technical debt in federal systems': [
    'legacy modernization', 'system modernization', 'technical debt reduction', 'modernize federal systems',
  ],
};

function toCapabilityEntries(map) {
  return Object.entries(map).map(([capability, terms]) => ({ capability, terms }));
}

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Seeds the ranking signal sets. `drivers` is a list of phrases; `capabilityMap`
 * is a list of { capability, terms } that widens a capability with related wording.
 */
async function seedBusinessDrivers(
  databasePath = DEFAULT_BUSINESS_DRIVER_DB,
  {
    companyId = COMPANY_ID,
    drivers = JE_ROCKER_DRIVERS,
    capabilityMap = toCapabilityEntries(JE_ROCKER_CAPABILITY_MAP),
    driverMap = toCapabilityEntries(JE_ROCKER_DRIVER_MAP),
  } = {},
) {
  const db = new sqlite3.Database(databasePath);

  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS business_drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      UNIQUE(company_id, driver)
    )
  `);

  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS capability_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      mapped_term TEXT NOT NULL,
      UNIQUE(company_id, capability, mapped_term)
    )
  `);

  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS driver_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      mapped_term TEXT NOT NULL,
      UNIQUE(company_id, driver, mapped_term)
    )
  `);

  for (const driver of drivers) {
    await runAsync(
      db,
      'INSERT INTO business_drivers (company_id, driver) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [companyId, String(driver).trim()],
    );
  }

  for (const entry of capabilityMap) {
    for (const term of entry.terms || []) {
      await runAsync(
        db,
        'INSERT INTO capability_map (company_id, capability, mapped_term) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [companyId, String(entry.capability).trim(), String(term).trim()],
      );
    }
  }

  for (const entry of driverMap) {
    for (const term of entry.terms || []) {
      await runAsync(
        db,
        'INSERT INTO driver_map (company_id, driver, mapped_term) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [companyId, String(entry.capability).trim(), String(term).trim()],
      );
    }
  }

  await new Promise((resolve) => db.close(resolve));
  return { drivers: drivers.length, capabilityMap: capabilityMap.length, driverMap: driverMap.length };
}

module.exports = {
  COMPANY_ID,
  DEFAULT_BUSINESS_DRIVER_DB,
  JE_ROCKER_CAPABILITY_MAP,
  JE_ROCKER_DRIVERS,
  JE_ROCKER_DRIVER_MAP,
  seedBusinessDrivers,
  toCapabilityEntries,
};

if (require.main === module) {
  seedBusinessDrivers()
    .then((counts) => console.log(`Seeded ${counts.drivers} drivers, ${counts.capabilityMap} capability mappings, ${counts.driverMap} driver mappings`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
