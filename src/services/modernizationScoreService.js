const { getClientById } = require('../utils/db');

const SCORE_WEIGHTS = Object.freeze({
  compliance: 0.2,
  modernization: 0.25,
  forecasting: 0.15,
  match: 0.15,
  mission: 0.1,
  pulse: 0.15,
});

function bounded(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function readinessScore(value) {
  return { low: 25, medium: 60, high: 100 }[String(value || '').toLowerCase()] || 0;
}

function forecastScore(value) {
  return { long: 35, medium: 65, short: 100 }[String(value || '').toLowerCase()] || 0;
}

function resultBreakdown(summary) {
  return {
    compliance: summary.compliance?.summary?.ready ? 100 : 0,
    modernization: readinessScore(summary.modernization?.readiness),
    forecasting: forecastScore(summary.forecasting?.forecastWindow),
    match: summary.pulse?.opportunityAlignmentStrength ?? 0,
    mission: summary.pulse?.missionAlignmentStrength ?? 0,
    pulse: summary.pulse?.operationalReadiness ?? 0,
  };
}

function interpretation(score) {
  if (score >= 75) return 'Modernization readiness is strong and supports near-term strategic execution.';
  if (score >= 45) return 'Modernization readiness is developing; targeted improvements should precede acceleration.';
  return 'Modernization readiness is limited; foundational remediation is required before strategic acceleration.';
}

async function generateModernizationScore(clientId, options = {}) {
  const getClient = options.getClient || getClientById;
  const getSummary = options.getSummary;
  const getBriefing = options.getBriefing;
  if (typeof getSummary !== 'function' || typeof getBriefing !== 'function') {
    throw new TypeError('Summary and briefing retrieval functions are required');
  }

  const client = await getClient(clientId, options.databasePath);
  if (!client) throw new Error(`Client ${clientId} was not found`);
  const [summary, briefing] = await Promise.all([getSummary(clientId), getBriefing(clientId)]);
  if (!summary || summary.status !== 'completed') throw new Error('Completed intelligence summary is required');
  if (!briefing || briefing.status !== 'completed') throw new Error('Completed client briefing is required');

  const rawBreakdown = resultBreakdown(summary);
  const breakdown = Object.fromEntries(Object.entries(rawBreakdown).map(([key, value]) => [key, bounded(value)]));
  const score = bounded(Object.entries(breakdown).reduce((total, [key, value]) => total + value * SCORE_WEIGHTS[key], 0));

  return {
    clientId: Number(clientId),
    status: 'completed',
    score,
    breakdown,
    interpretation: `${interpretation(score)} Advisory context: ${briefing.title || 'client briefing'}; ${summary.overallAssessment || 'review current readiness signals.'}`,
  };
}

module.exports = {
  SCORE_WEIGHTS,
  generateModernizationScore,
};