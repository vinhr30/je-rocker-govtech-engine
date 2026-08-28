const { getClientById } = require('../utils/db');

const RESULT_KEYS = ['compliance', 'modernization', 'forecasting', 'match', 'mission', 'pulse'];

function ensureCompletedResult(results, key) {
  const result = results?.[key];
  if (!result || result.status !== 'completed') {
    throw new Error(`Completed ${key} result is required`);
  }
  return result;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function overallAssessment(pulse, blockers) {
  if (pulse.riskLevel === 'high') return 'Readiness is constrained; resolve critical blockers before expanding pursuit activity.';
  if (blockers.length > 0) return 'Readiness is advancing, with targeted risks to resolve before acceleration.';
  return 'Readiness is strong; advance aligned opportunities within the current mission direction.';
}

async function generateIntelligenceSummary(clientId, options = {}) {
  const getClient = options.getClient || getClientById;
  const getResults = options.getResults;
  if (typeof getResults !== 'function') {
    throw new TypeError('A result retrieval function is required');
  }

  const client = await getClient(clientId, options.databasePath);
  if (!client) throw new Error(`Client ${clientId} was not found`);
  const results = await getResults(clientId);
  const [compliance, modernization, forecasting, match, mission, pulse] = RESULT_KEYS.map((key) => ensureCompletedResult(results, key));
  const keyRisks = unique([
    ...pulse.blockers,
    ...mission.blockers,
    ...match.blockers,
    ...forecasting.riskFactors,
    ...(compliance.summary.ready ? [] : ['Compliance readiness is incomplete']),
    ...(modernization.readiness === 'low' ? ['Modernization readiness is low'] : []),
  ]);
  const keyStrengths = unique([
    ...(compliance.summary.ready ? ['Compliance requirements are complete'] : []),
    ...(modernization.readiness === 'high' ? ['Modernization readiness is high'] : []),
    ...(forecasting.readinessScore >= 75 ? ['Forecast readiness is strong'] : []),
    ...(match.matched.length > 0 ? [`${match.matched.length} matched opportunities identified`] : []),
    ...(pulse.opportunityAlignmentStrength >= 70 ? ['Opportunity alignment is strong'] : []),
    ...(pulse.missionAlignmentStrength >= 70 ? ['Mission alignment is strong'] : []),
  ]);
  const recommendedActions = unique([
    ...pulse.recommendedActions,
    ...mission.recommendedActions,
    ...forecasting.recommendations,
    ...match.recommendations,
  ]);

  return {
    clientId: Number(clientId),
    status: 'completed',
    compliance,
    modernization,
    forecasting,
    match,
    mission,
    pulse,
    overallAssessment: overallAssessment(pulse, keyRisks),
    keyStrengths,
    keyRisks,
    recommendedActions,
  };
}

module.exports = {
  generateIntelligenceSummary,
};