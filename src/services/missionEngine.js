const { getClientById } = require('../utils/db');
const { triggerComplianceScan } = require('./complianceEngine');
const { triggerModernizationScan } = require('./modernizationEngine');
const { triggerForecastingRun } = require('./forecastingEngine');
const { triggerOpportunityMatch } = require('./opportunityMatchEngine');
const { INTELLIGENCE_LIFECYCLE_STATES } = require('./intelligenceActivationController');

function strongestDirection(forecastingResult, matchResult) {
  const topMatch = [...matchResult.matched].sort((left, right) => right.confidenceScore - left.confidenceScore)[0];
  if (topMatch) {
    return {
      market: topMatch.market,
      category: topMatch.category,
      basis: `Highest-confidence ${topMatch.category} opportunity match`,
    };
  }

  const topForecast = forecastingResult.predictedOpportunities[0];
  return {
    market: topForecast?.market || 'federal',
    category: 'general services',
    basis: topForecast ? 'Forecast opportunity-fit signal' : 'Client readiness baseline',
  };
}

async function triggerMissionGeneration(clientId, options = {}) {
  const getClient = options.getClient || getClientById;
  const client = await getClient(clientId, options.databasePath);
  if (!client) throw new Error(`Client ${clientId} was not found`);

  const runCompliance = options.triggerComplianceScan || triggerComplianceScan;
  const runModernization = options.triggerModernizationScan || triggerModernizationScan;
  const runForecasting = options.triggerForecastingRun || triggerForecastingRun;
  const runMatch = options.triggerOpportunityMatch || triggerOpportunityMatch;
  const [complianceResult, modernizationResult, forecastingResult, matchResult] = await Promise.all([
    runCompliance(clientId, { getClient: async () => client }),
    runModernization(clientId, { getClient: async () => client }),
    runForecasting(clientId, { getClient: async () => client }),
    runMatch(clientId, { getClient: async () => client }),
  ]);
  const direction = strongestDirection(forecastingResult, matchResult);
  const blockers = [...new Set([
    ...matchResult.blockers,
    ...(complianceResult.summary.ready ? [] : ['Compliance readiness is incomplete']),
    ...(modernizationResult.readiness === 'low' ? ['Modernization readiness is low'] : []),
    ...(forecastingResult.readinessScore >= 45 ? [] : ['Forecast readiness is low']),
  ])];
  const strategicDirection = [
    `Prioritize ${direction.market} ${direction.category} opportunities.`,
    `Use ${direction.basis.toLowerCase()} to sequence outreach and capture work.`,
    `Operate within the ${forecastingResult.forecastWindow} forecast window.`,
  ];
  const recommendedActions = [
    ...(blockers.length ? ['Resolve readiness blockers before committing bid resources.'] : ['Advance the highest-confidence matched opportunities.']),
    ...matchResult.recommendations,
    ...forecastingResult.recommendations,
  ];
  const clientName = client.name || client.client_name || `Client ${clientId}`;

  return {
    clientId: Number(clientId),
    status: INTELLIGENCE_LIFECYCLE_STATES.COMPLETED,
    missionTitle: `${clientName} Procurement Mission`,
    missionSummary: blockers.length
      ? `${clientName} should address ${blockers.length} readiness blocker${blockers.length === 1 ? '' : 's'} before pursuing ${direction.market} opportunities.`
      : `${clientName} is positioned to pursue ${direction.market} ${direction.category} opportunities in the ${forecastingResult.forecastWindow} window.`,
    strategicDirection,
    blockers,
    recommendedActions: [...new Set(recommendedActions)],
  };
}

function updateDashboardModules(moduleStates, missionResult) {
  return {
    ...moduleStates,
    mission: {
      state: missionResult.status,
      status: 'Completed',
      placeholder: '',
      summary: [
        { label: 'mission', value: missionResult.missionTitle },
        { label: 'direction', value: missionResult.strategicDirection[0] || 'N/A' },
        { label: 'blockers', value: String(missionResult.blockers.length) },
      ],
      result: missionResult,
    },
  };
}

module.exports = {
  triggerMissionGeneration,
  updateDashboardModules,
};