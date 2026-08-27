const { getClientById } = require('../utils/db');
const { triggerComplianceScan } = require('./complianceEngine');
const { triggerModernizationScan } = require('./modernizationEngine');
const { triggerForecastingRun } = require('./forecastingEngine');
const { triggerOpportunityMatch } = require('./opportunityMatchEngine');
const { triggerMissionGeneration } = require('./missionEngine');
const { INTELLIGENCE_LIFECYCLE_STATES } = require('./intelligenceActivationController');

function bounded(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function riskLevel(readiness, blockers) {
  if (blockers.length >= 4 || readiness < 40) return 'high';
  if (blockers.length > 0 || readiness < 70) return 'medium';
  return 'low';
}

async function triggerPulseScan(clientId, options = {}) {
  const getClient = options.getClient || getClientById;
  const client = await getClient(clientId, options.databasePath);
  if (!client) throw new Error(`Client ${clientId} was not found`);

  const runCompliance = options.triggerComplianceScan || triggerComplianceScan;
  const runModernization = options.triggerModernizationScan || triggerModernizationScan;
  const runForecasting = options.triggerForecastingRun || triggerForecastingRun;
  const runMatch = options.triggerOpportunityMatch || triggerOpportunityMatch;
  const runMission = options.triggerMissionGeneration || triggerMissionGeneration;
  const [complianceResult, modernizationResult, forecastingResult, matchResult, missionResult] = await Promise.all([
    runCompliance(clientId, { getClient: async () => client }),
    runModernization(clientId, { getClient: async () => client }),
    runForecasting(clientId, { getClient: async () => client }),
    runMatch(clientId, { getClient: async () => client }),
    runMission(clientId, { getClient: async () => client }),
  ]);
  const blockers = [...new Set([
    ...matchResult.blockers,
    ...missionResult.blockers,
    ...(complianceResult.summary.ready ? [] : ['Compliance readiness is incomplete']),
    ...(modernizationResult.readiness === 'low' ? ['Modernization readiness is low'] : []),
    ...(forecastingResult.readinessScore >= 45 ? [] : ['Forecast readiness is low']),
  ])];
  const opportunityAlignmentStrength = bounded(
    matchResult.matched.length * 15
    + (matchResult.confidenceScores.reduce((total, item) => total + item.score, 0) / Math.max(1, matchResult.confidenceScores.length)) * 0.55
  );
  const missionAlignmentStrength = bounded(
    (missionResult.strategicDirection.length ? 60 : 0)
    + (missionResult.blockers.length === 0 ? 40 : Math.max(0, 40 - missionResult.blockers.length * 10))
  );
  const operationalReadiness = bounded(
    (complianceResult.summary.ready ? 30 : Math.max(0, 30 - complianceResult.summary.issueCount * 7.5))
    + modernizationResult.score * 0.25
    + forecastingResult.readinessScore * 0.25
    + opportunityAlignmentStrength * 0.1
    + missionAlignmentStrength * 0.1
  );
  const momentum = bounded(
    forecastingResult.readinessScore * 0.35
    + opportunityAlignmentStrength * 0.35
    + missionAlignmentStrength * 0.3
  );
  const indicators = [
    { key: 'compliance', value: complianceResult.summary.ready ? 'ready' : 'needs attention' },
    { key: 'modernization', value: modernizationResult.readiness },
    { key: 'forecasting', value: forecastingResult.forecastWindow },
    { key: 'opportunity_alignment', value: opportunityAlignmentStrength },
    { key: 'mission_alignment', value: missionAlignmentStrength },
  ];
  const recommendedActions = [
    ...(blockers.length ? ['Resolve critical readiness blockers before accelerating pursuit activity.'] : ['Advance the highest-confidence opportunities aligned to the mission.']),
    ...missionResult.recommendedActions,
    ...forecastingResult.recommendations,
  ];

  return {
    clientId: Number(clientId),
    status: INTELLIGENCE_LIFECYCLE_STATES.COMPLETED,
    operationalReadiness,
    momentum,
    riskLevel: riskLevel(operationalReadiness, blockers),
    opportunityAlignmentStrength,
    missionAlignmentStrength,
    indicators,
    blockers,
    recommendedActions: [...new Set(recommendedActions)],
  };
}

function updateDashboardModules(moduleStates, pulseResult) {
  return {
    ...moduleStates,
    pulse: {
      state: pulseResult.status,
      status: 'Completed',
      placeholder: '',
      summary: [
        { label: 'operational readiness', value: `${pulseResult.operationalReadiness}/100` },
        { label: 'momentum', value: `${pulseResult.momentum}/100` },
        { label: 'risk level', value: pulseResult.riskLevel },
      ],
      result: pulseResult,
    },
  };
}

module.exports = {
  triggerPulseScan,
  updateDashboardModules,
};