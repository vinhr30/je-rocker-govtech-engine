const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { triggerMissionGeneration, updateDashboardModules } = require('../src/services/missionEngine');

test('mission engine synthesizes readiness, forecast, and match signals into a strategic narrative', async () => {
  const result = await triggerMissionGeneration(77, {
    getClient: async () => ({ id: 77, name: 'Mission Test' }),
    triggerComplianceScan: async () => ({ summary: { ready: true } }),
    triggerModernizationScan: async () => ({ readiness: 'high' }),
    triggerForecastingRun: async () => ({ forecastWindow: 'short', readinessScore: 88, predictedOpportunities: [{ market: 'federal' }], recommendations: [] }),
    triggerOpportunityMatch: async () => ({ matched: [{ market: 'federal', category: 'IT', confidenceScore: 91 }], blockers: [], recommendations: [] }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.missionTitle, 'Mission Test Procurement Mission');
  assert.match(result.missionSummary, /positioned to pursue federal IT opportunities/);
  assert.ok(Array.isArray(result.strategicDirection));
  assert.deepEqual(result.blockers, []);
  assert.ok(Array.isArray(result.recommendedActions));
});

test('mission engine carries readiness and match blockers into its mission result', async () => {
  const result = await triggerMissionGeneration(78, {
    getClient: async () => ({ id: 78, name: 'Blocked Test' }),
    triggerComplianceScan: async () => ({ summary: { ready: false } }),
    triggerModernizationScan: async () => ({ readiness: 'low' }),
    triggerForecastingRun: async () => ({ forecastWindow: 'long', readinessScore: 10, predictedOpportunities: [], recommendations: [] }),
    triggerOpportunityMatch: async () => ({ matched: [], blockers: ['Business size fit cannot be evaluated'], recommendations: [] }),
  });
  assert.ok(result.blockers.includes('Compliance readiness is incomplete'));
  assert.ok(result.blockers.includes('Modernization readiness is low'));
  assert.ok(result.blockers.includes('Business size fit cannot be evaluated'));
});

test('dashboard update completes only Mission and leaves Pulse pending', () => {
  const result = { status: 'completed', missionTitle: 'Test Mission', strategicDirection: ['Prioritize federal IT opportunities.'], blockers: [] };
  const update = updateDashboardModules({ pulse: 'pending' }, result);
  assert.equal(update.mission.status, 'Completed');
  assert.equal(update.mission.placeholder, '');
  assert.equal(update.pulse, 'pending');
});

test('dashboard Mission panel remains pending and does not trigger Mission or Pulse', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src/pages/ClientDashboardPage.jsx'), 'utf8');
  assert.match(dashboard, /Mission Panel/);
  assert.match(dashboard, /Mission strategy is pending\./);
  assert.doesNotMatch(dashboard, /triggerMissionGeneration|triggerPulse/);
});