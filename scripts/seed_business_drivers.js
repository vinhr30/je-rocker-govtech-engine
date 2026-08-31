const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DEFAULT_BUSINESS_DRIVER_DB = path.join(__dirname, '..', 'business_driver.db');
const COMPANY_ID = 'jerocker';

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
  { companyId = COMPANY_ID, drivers = [], capabilityMap = [] } = {},
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

  await new Promise((resolve) => db.close(resolve));
  return { drivers: drivers.length, capabilityMap: capabilityMap.length };
}

module.exports = { COMPANY_ID, DEFAULT_BUSINESS_DRIVER_DB, seedBusinessDrivers };

if (require.main === module) {
  seedBusinessDrivers()
    .then((counts) => console.log(`Seeded ${counts.drivers} drivers, ${counts.capabilityMap} capability mappings`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
