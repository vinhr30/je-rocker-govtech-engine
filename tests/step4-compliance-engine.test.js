const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createClient, getClientById } = require('../src/utils/db');
const { triggerComplianceScan, updateDashboardModules } = require('../src/services/complianceEngine');

test('compliance engine reads a client and returns structured missing-field checks', async () => {
  const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'step4-compliance-')), 'client.db');
  const client = await createClient({ name: 'Compliance Test', agency: 'GSA' }, databasePath);
  const result = await triggerComplianceScan(client.id, { databasePath });

  assert.equal(result.state, 'completed');
  assert.deepEqual(Object.keys(result.checks), ['sam_registration', 'uei', 'naics', 'business_classifications']);
  assert.deepEqual(result.summary.missing, ['sam_registration', 'uei', 'naics', 'business_classifications']);
  assert.equal(result.summary.issueCount, 4);
  fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
});

test('compliance engine completes when the required client fields are present', async () => {
  const client = {
    id: 42,
    sam_registration: 'active',
    uei: 'ABC123',
    naics: '541512',
    business_classifications: 'Small Business',
  };
  const result = await triggerComplianceScan(client.id, { getClient: async () => client });
  assert.equal(result.summary.ready, true);
  assert.equal(result.summary.issueCount, 0);
});

test('dashboard update completes only compliance and leaves other engines pending', () => {
  const complianceResult = { state: 'completed', summary: { ready: false } };
  const update = updateDashboardModules({ modernization: 'pending', forecasting: 'pending', match: 'pending', mission: 'pending', pulse: 'pending' }, complianceResult);
  assert.equal(update.compliance.state, 'completed');
  assert.equal(update.compliance.status, 'Completed');
  assert.equal(update.compliance.placeholder, '');
  assert.deepEqual(
    Object.fromEntries(Object.entries(update).filter(([key]) => key !== 'compliance')),
    { modernization: 'pending', forecasting: 'pending', match: 'pending', mission: 'pending', pulse: 'pending' }
  );
});

test('dashboard renders compliance as pending until a future activation step', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src/pages/ClientDashboardPage.jsx'), 'utf8');
  assert.match(dashboard, /Compliance Panel/);
  assert.match(dashboard, /Compliance review is pending\./);
  assert.doesNotMatch(dashboard, /triggerComplianceScan/);
});