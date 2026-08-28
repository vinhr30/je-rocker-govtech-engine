const assert = require('assert');
const test = require('node:test');

const { generateClientBriefing } = require('../src/services/clientBriefingService');

function intelligenceSummary() {
  return {
    status: 'completed',
    compliance: { status: 'completed', summary: { ready: true } },
    modernization: { status: 'completed', readiness: 'high' },
    forecasting: { status: 'completed', forecastWindow: 'short' },
    match: { status: 'completed', matched: [{ id: 'opp-1' }] },
    mission: { status: 'completed', strategicDirection: ['Prioritize federal IT opportunities.'] },
    pulse: { status: 'completed', operationalReadiness: 88, momentum: 82, riskLevel: 'low', opportunityAlignmentStrength: 90, missionAlignmentStrength: 85 },
    overallAssessment: 'Readiness is strong.',
    keyStrengths: ['Strong client profile'],
    keyRisks: [],
    recommendedActions: ['Review the shortlist.'],
  };
}

test('briefing generator creates a completed narrative across all intelligence themes', async () => {
  let activationCount = 0;
  const briefing = await generateClientBriefing(111, {
    getClient: async () => ({ id: 111, name: 'Briefing Test' }),
    getSummary: async () => intelligenceSummary(),
    activateEngine: () => { activationCount += 1; },
  });
  assert.equal(briefing.status, 'completed');
  assert.match(briefing.title, /Briefing Test/);
  assert.match(briefing.executiveSummary, /high modernization posture/);
  assert.match(briefing.opportunityOutlook, /1 matched opportunities/);
  assert.match(briefing.strategicDirection, /federal IT/);
  assert.match(briefing.modernizationImplications, /high/);
  assert.equal(briefing.themes.compliancePosture, 'ready');
  assert.equal(briefing.themes.pulseMetrics.momentum, 82);
  assert.ok(briefing.strengths.length > 0);
  assert.ok(briefing.nextSteps.length > 0);
  assert.equal(activationCount, 0);
});

test('briefing generator carries summary risks and readiness implications', async () => {
  const summary = intelligenceSummary();
  summary.compliance.summary.ready = false;
  summary.modernization.readiness = 'low';
  summary.pulse.opportunityAlignmentStrength = 20;
  summary.keyRisks = ['Missing registration'];
  const briefing = await generateClientBriefing(112, {
    getClient: async () => ({ id: 112, name: 'Risk Test' }),
    getSummary: async () => summary,
  });
  assert.ok(briefing.risks.includes('Missing registration'));
  assert.ok(briefing.risks.includes('Compliance posture requires remediation.'));
  assert.ok(briefing.risks.includes('Opportunity alignment is not yet strong.'));
  assert.match(briefing.modernizationImplications, /requires foundational improvement/);
});

test('briefing requires a completed retrieved summary and has no dashboard update contract', async () => {
  await assert.rejects(
    generateClientBriefing(113, { getClient: async () => ({ id: 113 }), getSummary: async () => ({}) }),
    /Completed intelligence summary is required/
  );
  const briefing = await generateClientBriefing(113, { getClient: async () => ({ id: 113 }), getSummary: async () => intelligenceSummary() });
  assert.equal(typeof briefing.updateDashboardModules, 'undefined');
});