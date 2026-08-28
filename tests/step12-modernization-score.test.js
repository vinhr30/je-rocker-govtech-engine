const assert = require('assert');
const test = require('node:test');

const { generateModernizationScore, SCORE_WEIGHTS } = require('../src/services/modernizationScoreService');

function summary() {
  return {
    status: 'completed',
    compliance: { summary: { ready: true } },
    modernization: { readiness: 'high' },
    forecasting: { forecastWindow: 'short' },
    pulse: { operationalReadiness: 90, opportunityAlignmentStrength: 80, missionAlignmentStrength: 70 },
    overallAssessment: 'Readiness is strong.',
  };
}

test('modernization score generator reads summary and briefing without activating engines', async () => {
  let activationCount = 0;
  const result = await generateModernizationScore(121, {
    getClient: async () => ({ id: 121 }),
    getSummary: async () => summary(),
    getBriefing: async () => ({ status: 'completed', title: 'Score Briefing' }),
    activateEngine: () => { activationCount += 1; },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.breakdown, { compliance: 100, modernization: 100, forecasting: 100, match: 80, mission: 70, pulse: 90 });
  assert.equal(result.score, 93);
  assert.match(result.interpretation, /strong/);
  assert.equal(activationCount, 0);
});

test('modernization score uses the approved weighted factors', () => {
  assert.deepEqual(SCORE_WEIGHTS, { compliance: 0.2, modernization: 0.25, forecasting: 0.15, match: 0.15, mission: 0.1, pulse: 0.15 });
});

test('modernization score requires completed summary and briefing without a dashboard update contract', async () => {
  await assert.rejects(
    generateModernizationScore(122, { getClient: async () => ({ id: 122 }), getSummary: async () => ({ status: 'pending' }), getBriefing: async () => ({ status: 'completed' }) }),
    /Completed intelligence summary is required/
  );
  const result = await generateModernizationScore(122, { getClient: async () => ({ id: 122 }), getSummary: async () => summary(), getBriefing: async () => ({ status: 'completed', title: 'Briefing' }) });
  assert.equal(typeof result.updateDashboardModules, 'undefined');
});