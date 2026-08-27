const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const dashboardPath = path.join(__dirname, '..', 'src/pages/ClientDashboardPage.jsx');

test('new client dashboard activation loads profile into a pending shell', () => {
  const dashboard = fs.readFileSync(dashboardPath, 'utf8');
  assert.match(dashboard, /new URLSearchParams\(window\.location\.search\)\.get\('client_id'\)/);
  assert.match(dashboard, /activatePendingClient\(clientId\)/);
  assert.match(dashboard, /setActiveClient\(client\)/);
  assert.match(dashboard, /setClientProfile\(client\)/);
  assert.match(dashboard, /resetModules\('Pending'\)/);
});

test('all Step 2 modules have named pending placeholders and no engine calls', () => {
  const dashboard = fs.readFileSync(dashboardPath, 'utf8');
  for (const placeholder of [
    'Weekly intelligence is pending.',
    'Opportunity analysis is pending.',
    'Match analysis is pending.',
    'Spend analysis is pending.',
    'Vendor analysis is pending.',
    'Capture planning is pending.',
  ]) {
    assert.ok(dashboard.includes(placeholder));
  }
  assert.doesNotMatch(dashboard, /\/api\/client\/intel/);
  assert.doesNotMatch(dashboard, /loadModuleSummary|loadModuleDeep|loadOpportunityIntel|activateClient/);
});