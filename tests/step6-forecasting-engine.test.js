const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { triggerForecastingRun, updateDashboardModules } = require('../src/services/forecastingEngine');

const readyClient = {
  id: 99,
  sam_registration: 'active',
  uei: 'UEI123',
  naics: '541512',
  business_classifications: 'Small Business',
  business_size: 'small',
  procurement_history: 'GSA schedule',
  modernization_profile: JSON.stringify({
    website: 'https://example.com', domain: 'example.com', ssl: true,
    cloud_adoption: 'Microsoft 365', automation: 'CRM', cybersecurity: 'MFA',
    procurement_readiness: 'Capability statement', business_practices: 'current',
  }),
};

test('forecasting runs compliance and modernization dependencies and returns a structured result', async () => {
  const result = await triggerForecastingRun(99, {
    getClient: async () => readyClient,
    opportunityFit: { federal: 3, state: 2, local: 1 },
  });
  assert.equal(result.status, 'completed');
  assert.ok(result.readinessScore >= 0 && result.readinessScore <= 100);
  assert.equal(result.forecastWindow, 'short');
  assert.deepEqual(result.predictedOpportunities.map((item) => item.market), ['federal', 'state', 'local']);
  assert.deepEqual(result.riskFactors, []);
  assert.ok(Array.isArray(result.recommendations));
});

test('forecasting reports risks for incomplete client readiness', async () => {
  const result = await triggerForecastingRun(100, { getClient: async () => ({ id: 100 }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.forecastWindow, 'long');
  assert.ok(result.riskFactors.includes('Compliance gaps remain'));
  assert.ok(result.riskFactors.includes('No opportunity-fit evidence supplied'));
});

test('dashboard update completes only forecasting and leaves other engines pending', () => {
  const result = { status: 'completed', readinessScore: 62, forecastWindow: 'medium', predictedOpportunities: [] };
  const update = updateDashboardModules({ match: 'pending', mission: 'pending', pulse: 'pending' }, result);
  assert.equal(update.forecasting.status, 'Completed');
  assert.equal(update.forecasting.placeholder, '');
  assert.deepEqual(
    Object.fromEntries(Object.entries(update).filter(([key]) => key !== 'forecasting')),
    { match: 'pending', mission: 'pending', pulse: 'pending' }
  );
});

test('dashboard forecasting panel remains pending and does not trigger forecasting', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src/pages/ClientDashboardPage.jsx'), 'utf8');
  assert.match(dashboard, /Forecasting Panel/);
  assert.match(dashboard, /Forecasting review is pending\./);
  assert.doesNotMatch(dashboard, /triggerForecastingRun/);
});