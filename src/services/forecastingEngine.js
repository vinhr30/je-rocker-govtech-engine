const { getClientById } = require('../utils/db');
const { triggerComplianceScan } = require('./complianceEngine');
const { triggerModernizationScan } = require('./modernizationEngine');
const { INTELLIGENCE_LIFECYCLE_STATES } = require('./intelligenceActivationController');

function listValue(value) {
  return String(value || '').split(/[,;|]/).map((entry) => entry.trim()).filter(Boolean);
}

function normalizeFits(value = {}) {
  return {
    federal: Number(value.federal || 0),
    state: Number(value.state || 0),
    local: Number(value.local || 0),
  };
}

function forecastWindow(score) {
  if (score >= 75) return 'short';
  if (score >= 45) return 'medium';
  return 'long';
}

async function triggerForecastingRun(clientId, options = {}) {
  const getClient = options.getClient || getClientById;
  const client = await getClient(clientId, options.databasePath);
  if (!client) throw new Error(`Client ${clientId} was not found`);

  const runCompliance = options.triggerComplianceScan || triggerComplianceScan;
  const runModernization = options.triggerModernizationScan || triggerModernizationScan;
  const [complianceResult, modernizationResult] = await Promise.all([
    runCompliance(clientId, { getClient: async () => client }),
    runModernization(clientId, { getClient: async () => client }),
  ]);
  const naics = listValue(client.naics);
  const procurementHistory = listValue(client.procurement_history);
  const fits = normalizeFits(options.opportunityFit);
  const hasIndustry = naics.length > 0;
  const hasBusinessSize = String(client.business_size || '').trim().length > 0;
  const hasHistory = procurementHistory.length > 0;
  const totalFit = fits.federal + fits.state + fits.local;
  const readinessScore = Math.round(
    (complianceResult.summary.ready ? 30 : Math.max(0, 30 - complianceResult.summary.issueCount * 7.5))
    + modernizationResult.score * 0.3
    + (hasBusinessSize ? 10 : 0)
    + (hasIndustry ? 10 : 0)
    + (hasHistory ? 10 : 0)
    + (totalFit > 0 ? 10 : 0)
  );
  const riskFactors = [
    ...(complianceResult.summary.ready ? [] : ['Compliance gaps remain']),
    ...(modernizationResult.readiness === 'low' ? ['Low modernization readiness'] : []),
    ...(hasBusinessSize ? [] : ['Business size not documented']),
    ...(hasIndustry ? [] : ['NAICS alignment not documented']),
    ...(hasHistory ? [] : ['No procurement history documented']),
    ...(totalFit > 0 ? [] : ['No opportunity-fit evidence supplied']),
  ];
  const predictedOpportunities = Object.entries(fits)
    .filter(([, count]) => count > 0)
    .map(([market, count]) => ({ market, count, naicsAligned: hasIndustry }));
  const recommendations = [
    ...(complianceResult.summary.ready ? [] : ['Close missing compliance items before near-term pursuit.']),
    ...modernizationResult.recommendations,
    ...(hasHistory ? [] : ['Document relevant procurement history.']),
    ...(totalFit > 0 ? [] : ['Provide federal, state, or local opportunity-fit evidence.']),
  ];

  return {
    clientId: Number(clientId),
    status: INTELLIGENCE_LIFECYCLE_STATES.COMPLETED,
    readinessScore: Math.max(0, Math.min(100, readinessScore)),
    forecastWindow: forecastWindow(readinessScore),
    predictedOpportunities,
    riskFactors,
    recommendations,
  };
}

function updateDashboardModules(moduleStates, forecastingResult) {
  return {
    ...moduleStates,
    forecasting: {
      state: forecastingResult.status,
      status: 'Completed',
      placeholder: '',
      summary: [
        { label: 'readiness score', value: `${forecastingResult.readinessScore}/100` },
        { label: 'forecast window', value: forecastingResult.forecastWindow },
        { label: 'predicted opportunities', value: String(forecastingResult.predictedOpportunities.length) },
      ],
      result: forecastingResult,
    },
  };
}

module.exports = {
  triggerForecastingRun,
  updateDashboardModules,
};