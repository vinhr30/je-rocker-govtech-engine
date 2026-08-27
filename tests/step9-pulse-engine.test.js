const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { triggerPulseScan, updateDashboardModules } = require('../src/services/pulseEngine');

function readyDependencies() {
  return {
    triggerComplianceScan: async () => ({ summary: { ready: true, issueCount: 0 } }),
    triggerModernizationScan: async () => ({ readiness: 'high', score: 100 }),
    triggerForecastingRun: async () => ({ readinessScore: 90, forecastWindow: 'short', recommendations: [] }),
    triggerOpportunityMatch: async () => ({ matched: [{ id: 'opp-1' }], confidenceScores: [{ id: 'opp-1', score: 90 }], blockers: [] }),
    triggerMissionGeneration: async () => ({ strategicDirection: ['Prioritize federal IT opportunities.'], blockers: [], recommendedActions: [] }),
  };
}

test('pulse engine synthesizes prior engine results into structured metrics', async () => {
  const result = await triggerPulseScan(91, { getClient: async () => ({ id: 91 }), ...readyDependencies() });
  assert.equal(result.status, 'completed');
  assert.ok(result.operationalReadiness >= 0 && result.operationalReadiness <= 100);
  assert.ok(result.momentum >= 0 && result.momentum <= 100);
  assert.equal(result.riskLevel, 'low');
  assert.equal(result.indicators.length, 5);
  assert.deepEqual(result.blockers, []);
});

test('pulse engine identifies critical blockers and high risk', async () => {
  const result = await triggerPulseScan(92, {
    getClient: async () => ({ id: 92 }),
    triggerComplianceScan: async () => ({ summary: { ready: false, issueCount: 4 } }),
    triggerModernizationScan: async () => ({ readiness: 'low', score: 0 }),
    triggerForecastingRun: async () => ({ readinessScore: 0, forecastWindow: 'long', recommendations: [] }),
    triggerOpportunityMatch: async () => ({ matched: [], confidenceScores: [], blockers: ['Business size fit cannot be evaluated'] }),
    triggerMissionGeneration: async () => ({ strategicDirection: [], blockers: ['No mission direction'], recommendedActions: [] }),
  });
  assert.equal(result.riskLevel, 'high');
  assert.ok(result.blockers.includes('Compliance readiness is incomplete'));
  assert.ok(result.blockers.includes('No mission direction'));
});

test('dashboard update completes only Pulse and retains incoming module states', () => {
  const result = { status: 'completed', operationalReadiness: 75, momentum: 70, riskLevel: 'medium' };
  const update = updateDashboardModules({ compliance: 'completed', mission: 'completed', match: 'completed' }, result);
  assert.equal(update.pulse.status, 'Completed');
  assert.equal(update.pulse.placeholder, '');
  assert.deepEqual({ compliance: update.compliance, mission: update.mission, match: update.match }, { compliance: 'completed', mission: 'completed', match: 'completed' });
});

test('dashboard Pulse panel remains pending and does not trigger Pulse', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src/pages/ClientDashboardPage.jsx'), 'utf8');
  assert.match(dashboard, /Pulse Panel/);
  assert.match(dashboard, /Operational pulse is pending\./);
  assert.doesNotMatch(dashboard, /triggerPulseScan/);
});