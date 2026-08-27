const { getClientById } = require('../utils/db');
const { triggerComplianceScan } = require('./complianceEngine');
const { triggerModernizationScan } = require('./modernizationEngine');
const { triggerForecastingRun } = require('./forecastingEngine');
const { INTELLIGENCE_LIFECYCLE_STATES } = require('./intelligenceActivationController');

function listValue(value) {
  return String(value || '').split(/[,;|]/).map((entry) => entry.trim()).filter(Boolean);
}

function normalizeSize(value) {
  const size = String(value || '').trim().toLowerCase();
  return ['micro', 'small', 'mid-size'].includes(size) ? size : '';
}

function classifyCategory(candidate) {
  const text = `${candidate.category || ''} ${candidate.title || ''} ${candidate.description || ''}`.toLowerCase();
  if (/cyber|cloud|software|data|it\b|technology/.test(text)) return 'IT';
  if (/admin|staffing|management|consulting/.test(text)) return 'admin';
  if (/health|medical|clinical/.test(text)) return 'health';
  if (/construction|facility|building|repair/.test(text)) return 'construction';
  return 'other';
}

function confidence(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

async function triggerOpportunityMatch(clientId, options = {}) {
  const getClient = options.getClient || getClientById;
  const client = await getClient(clientId, options.databasePath);
  if (!client) throw new Error(`Client ${clientId} was not found`);

  const runCompliance = options.triggerComplianceScan || triggerComplianceScan;
  const runModernization = options.triggerModernizationScan || triggerModernizationScan;
  const runForecasting = options.triggerForecastingRun || triggerForecastingRun;
  const getOpportunities = options.getOpportunities || (async () => []);
  const [complianceResult, modernizationResult, forecastingResult, candidates] = await Promise.all([
    runCompliance(clientId, { getClient: async () => client }),
    runModernization(clientId, { getClient: async () => client }),
    runForecasting(clientId, {
      getClient: async () => client,
      triggerComplianceScan: async () => runCompliance(clientId, { getClient: async () => client }),
      triggerModernizationScan: async () => runModernization(clientId, { getClient: async () => client }),
    }),
    getOpportunities(clientId),
  ]);
  const clientNaics = listValue(client.naics);
  const clientSize = normalizeSize(client.business_size);
  const blockers = [
    ...(complianceResult.summary.ready ? [] : ['Compliance readiness is incomplete']),
    ...(modernizationResult.readiness === 'low' ? ['Modernization readiness is low'] : []),
    ...(forecastingResult.readinessScore >= 45 ? [] : ['Forecast readiness is low']),
    ...(clientNaics.length ? [] : ['NAICS alignment cannot be evaluated']),
    ...(clientSize ? [] : ['Business size fit cannot be evaluated']),
  ];
  const matched = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const candidateNaics = listValue(candidate.naics || candidate.naics_code);
    const naicsAligned = clientNaics.some((code) => candidateNaics.includes(code));
    const sizeFits = !candidate.business_size || !clientSize || normalizeSize(candidate.business_size) === clientSize;
    const market = String(candidate.market || 'federal').toLowerCase();
    const forecastFit = forecastingResult.predictedOpportunities.some((entry) => entry.market === market);
    const category = classifyCategory(candidate);
    const categoryFits = listValue(client.capability_signals).some((signal) => `${signal} ${category}`.toLowerCase().includes(category.toLowerCase()));
    const score = confidence(
      (naicsAligned ? 35 : 0)
      + (sizeFits ? 15 : 0)
      + (complianceResult.summary.ready ? 15 : 0)
      + (modernizationResult.readiness !== 'low' ? 10 : 0)
      + (forecastFit ? 15 : 0)
      + (categoryFits ? 10 : 0)
    );
    return {
      id: candidate.id || candidate.url || candidate.title,
      title: candidate.title || 'Untitled opportunity',
      market,
      category,
      naicsAligned,
      businessSizeFit: sizeFits,
      confidenceScore: score,
      matched: score >= 50,
    };
  }).filter((candidate) => candidate.matched);
  const confidenceScores = matched.map(({ id, confidenceScore }) => ({ id, score: confidenceScore }));
  const recommendations = [
    ...(blockers.length ? ['Resolve readiness blockers before pursuing low-confidence opportunities.'] : ['Prioritize high-confidence opportunities in the forecast window.']),
    ...(matched.length ? [] : ['Add opportunity candidates with NAICS, market, and category information.']),
  ];

  return {
    clientId: Number(clientId),
    status: INTELLIGENCE_LIFECYCLE_STATES.COMPLETED,
    matched,
    confidenceScores,
    blockers,
    recommendations,
  };
}

function updateDashboardModules(moduleStates, matchResult) {
  return {
    ...moduleStates,
    match: {
      state: matchResult.status,
      status: 'Completed',
      placeholder: '',
      summary: [
        { label: 'matched opportunities', value: String(matchResult.matched.length) },
        { label: 'blockers', value: String(matchResult.blockers.length) },
      ],
      result: matchResult,
    },
  };
}

module.exports = {
  triggerOpportunityMatch,
  updateDashboardModules,
};