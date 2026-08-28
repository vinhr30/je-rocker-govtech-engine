const assert = require('assert');
const test = require('node:test');

const { generateIntelligenceSummary } = require('../src/services/intelligenceSummaryService');

function completedResults() {
  return {
    compliance: { status: 'completed', summary: { ready: true } },
    modernization: { status: 'completed', readiness: 'high' },
    forecasting: { status: 'completed', readinessScore: 90, riskFactors: [], recommendations: ['Maintain forecast review.'] },
    match: { status: 'completed', matched: [{ id: 'opp-1' }], blockers: [], recommendations: ['Review matched opportunities.'] },
    mission: { status: 'completed', blockers: [], recommendedActions: ['Advance mission priorities.'] },
    pulse: {
      status: 'completed', riskLevel: 'low', blockers: [], recommendedActions: ['Advance aligned work.'],
      opportunityAlignmentStrength: 85, missionAlignmentStrength: 90,
    },
  };
}

test('summary generator synthesizes all six completed engine outputs', async () => {
  let triggerCount = 0;
  const summary = await generateIntelligenceSummary(101, {
    getClient: async () => ({ id: 101, name: 'Summary Test' }),
    getResults: async () => completedResults(),
    triggerEngine: () => { triggerCount += 1; },
  });
  assert.equal(summary.status, 'completed');
  for (const key of ['compliance', 'modernization', 'forecasting', 'match', 'mission', 'pulse']) {
    assert.equal(summary[key].status, 'completed');
  }
  assert.ok(summary.keyStrengths.length > 0);
  assert.deepEqual(summary.keyRisks, []);
  assert.ok(summary.recommendedActions.length > 0);
  assert.equal(triggerCount, 0);
});

test('summary generator aggregates risks without updating dashboard modules', async () => {
  const results = completedResults();
  results.compliance.summary.ready = false;
  results.pulse.riskLevel = 'high';
  results.pulse.blockers = ['Missing SAM registration'];
  results.mission.blockers = ['Mission blocked'];
  const summary = await generateIntelligenceSummary(102, {
    getClient: async () => ({ id: 102 }),
    getResults: async () => results,
  });
  assert.match(summary.overallAssessment, /Readiness is constrained/);
  assert.ok(summary.keyRisks.includes('Missing SAM registration'));
  assert.ok(summary.keyRisks.includes('Compliance readiness is incomplete'));
  assert.equal(typeof summary.updateDashboardModules, 'undefined');
});

test('summary generator requires retrieved completed results instead of activating engines', async () => {
  await assert.rejects(
    generateIntelligenceSummary(103, { getClient: async () => ({ id: 103 }), getResults: async () => ({}) }),
    /Completed compliance result is required/
  );
  await assert.rejects(
    generateIntelligenceSummary(103, { getClient: async () => ({ id: 103 }) }),
    /result retrieval function is required/
  );
});