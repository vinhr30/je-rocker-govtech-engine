const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { triggerOpportunityMatch, updateDashboardModules } = require('../src/services/opportunityMatchEngine');

const client = { id: 55, naics: '541512', business_size: 'small', capability_signals: 'IT cloud automation' };
const compliant = { summary: { ready: true } };
const modernized = { readiness: 'high' };
const forecast = { readinessScore: 88, predictedOpportunities: [{ market: 'federal' }] };

test('opportunity match engine evaluates real candidate attributes into structured matches', async () => {
  const result = await triggerOpportunityMatch(55, {
    getClient: async () => client,
    triggerComplianceScan: async () => compliant,
    triggerModernizationScan: async () => modernized,
    triggerForecastingRun: async () => forecast,
    getOpportunities: async () => [{ id: 'opp-1', title: 'Cloud IT modernization', market: 'federal', naics_code: '541512', business_size: 'small' }],
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].category, 'IT');
  assert.equal(result.confidenceScores[0].score, 100);
  assert.deepEqual(result.blockers, []);
});

test('opportunity match engine reports readiness blockers without running mission or pulse', async () => {
  const result = await triggerOpportunityMatch(56, {
    getClient: async () => ({ id: 56 }),
    triggerComplianceScan: async () => ({ summary: { ready: false } }),
    triggerModernizationScan: async () => ({ readiness: 'low' }),
    triggerForecastingRun: async () => ({ readinessScore: 10, predictedOpportunities: [] }),
  });
  assert.ok(result.blockers.includes('Compliance readiness is incomplete'));
  assert.equal(result.matched.length, 0);
});

test('dashboard update completes only Match and leaves mission and pulse pending', () => {
  const result = { status: 'completed', matched: [], blockers: [] };
  const update = updateDashboardModules({ mission: 'pending', pulse: 'pending' }, result);
  assert.equal(update.match.status, 'Completed');
  assert.equal(update.match.placeholder, '');
  assert.deepEqual({ mission: update.mission, pulse: update.pulse }, { mission: 'pending', pulse: 'pending' });
});

test('dashboard Match panel remains pending and does not trigger matching', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src/pages/ClientDashboardPage.jsx'), 'utf8');
  assert.match(dashboard, /Match Panel/);
  assert.match(dashboard, /Opportunity matching is pending\./);
  assert.doesNotMatch(dashboard, /triggerOpportunityMatch/);
});