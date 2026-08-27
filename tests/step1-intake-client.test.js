const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { clientEvents, createClient } = require('../src/utils/db');

test('createClient persists a pending client and emits onClientCreated', async () => {
  const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'step1-client-')), 'client.db');
  const events = [];
  clientEvents.once('onClientCreated', (client) => events.push(client));

  const client = await createClient({
    name: 'Step 1 Test Client',
    agency: 'GSA',
    notes: 'Pending intake',
    capability_signals: 'cloud',
    targeting_preferences: 'civilian',
  }, databasePath);

  assert.ok(client.id);
  assert.equal(client.lifecycle_status, 'pending');
  assert.equal(events.length, 1);
  assert.equal(events[0].id, client.id);
  fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
});

test('Step 1 dashboard shell keeps modules pending and does not load intelligence', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src/pages/ClientDashboardPage.jsx'), 'utf8');
  assert.match(dashboard, /status: 'Pending'/);
  assert.match(dashboard, /disabled\s*>\s*Pending/);
  const pendingClientFunction = dashboard.match(/async function loadPendingClient[\s\S]*?\n  }/);
  assert.ok(pendingClientFunction);
  assert.doesNotMatch(pendingClientFunction[0], /\/api\/client\/intel/);
});

test('intake posts client creation and opens the pending dashboard shell', () => {
  const intake = fs.readFileSync(path.join(__dirname, '..', 'src/pages/ClientIntake/ClientIntakePage.jsx'), 'utf8');
  assert.match(intake, /fetch\('\/api\/clients'/);
  assert.match(intake, /client-dashboard\?client_id=/);
  assert.match(intake, /created=1/);
});