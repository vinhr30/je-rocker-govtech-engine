const { getClientById } = require('../utils/db');

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function firstDirection(summary) {
  return summary.mission?.strategicDirection?.[0] || 'Maintain a measured pursuit posture while readiness is developed.';
}

async function generateClientBriefing(clientId, options = {}) {
  const getClient = options.getClient || getClientById;
  const getSummary = options.getSummary;
  if (typeof getSummary !== 'function') {
    throw new TypeError('A summary retrieval function is required');
  }

  const client = await getClient(clientId, options.databasePath);
  if (!client) throw new Error(`Client ${clientId} was not found`);
  const summary = await getSummary(clientId);
  if (!summary || summary.status !== 'completed') {
    throw new Error('Completed intelligence summary is required');
  }

  const name = client.name || client.client_name || `Client ${clientId}`;
  const complianceReady = Boolean(summary.compliance?.summary?.ready);
  const modernizationReadiness = summary.modernization?.readiness || 'unknown';
  const forecastWindow = summary.forecasting?.forecastWindow || 'long';
  const matchedCount = summary.match?.matched?.length || 0;
  const opportunityStrength = summary.pulse?.opportunityAlignmentStrength ?? 0;
  const missionStrength = summary.pulse?.missionAlignmentStrength ?? 0;
  const strengths = unique([
    ...summary.keyStrengths,
    complianceReady ? 'Compliance posture is ready for pursuit planning.' : '',
    modernizationReadiness === 'high' ? 'Modernization readiness supports near-term execution.' : '',
    matchedCount ? `${matchedCount} aligned opportunities are available for review.` : '',
  ]);
  const risks = unique([
    ...summary.keyRisks,
    ...(complianceReady ? [] : ['Compliance posture requires remediation.']),
    ...(modernizationReadiness === 'low' ? ['Modernization readiness may slow execution.'] : []),
    ...(opportunityStrength < 50 ? ['Opportunity alignment is not yet strong.'] : []),
  ]);
  const nextSteps = unique([
    ...summary.recommendedActions,
    ...(matchedCount ? ['Prioritize and qualify the strongest matched opportunities.'] : ['Build a qualified opportunity shortlist.']),
    `Plan activity against the ${forecastWindow} forecast window.`,
  ]);

  return {
    clientId: Number(clientId),
    status: 'completed',
    title: `${name} Client Advisory Briefing`,
    executiveSummary: `${name} has a ${modernizationReadiness} modernization posture, a ${forecastWindow} opportunity window, and ${opportunityStrength}/100 opportunity alignment. ${summary.overallAssessment}`,
    strengths,
    risks,
    opportunityOutlook: `${matchedCount} matched opportunities with ${opportunityStrength}/100 alignment are available for the ${forecastWindow} window.`,
    strategicDirection: firstDirection(summary),
    nextSteps,
    modernizationImplications: `Modernization readiness is ${modernizationReadiness}; this ${modernizationReadiness === 'low' ? 'requires foundational improvement before scaling pursuit activity' : 'supports a focused path from readiness into pursuit execution'}.`,
    themes: {
      compliancePosture: complianceReady ? 'ready' : 'needs attention',
      modernizationReadiness,
      forecastingWindow: forecastWindow,
      opportunityAlignment: opportunityStrength,
      missionDirection: firstDirection(summary),
      pulseMetrics: {
        operationalReadiness: summary.pulse?.operationalReadiness ?? null,
        momentum: summary.pulse?.momentum ?? null,
        riskLevel: summary.pulse?.riskLevel || 'unknown',
        missionAlignment: missionStrength,
      },
    },
  };
}

module.exports = {
  generateClientBriefing,
};