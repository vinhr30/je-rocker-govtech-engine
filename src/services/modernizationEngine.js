const { getClientById } = require('../utils/db');
const { INTELLIGENCE_LIFECYCLE_STATES } = require('./intelligenceActivationController');

const ASSESSMENTS = [
  ['digital_presence', 'Digital presence', 'Establish a current website, verified domain, and SSL certificate.'],
  ['cloud_adoption', 'Cloud adoption', 'Document cloud tools or a cloud adoption plan.'],
  ['automation', 'Automation', 'Identify repeatable workflows suitable for automation.'],
  ['cybersecurity', 'Cybersecurity basics', 'Document baseline cybersecurity controls and ownership.'],
  ['procurement_readiness', 'Procurement readiness', 'Maintain current capability statements and procurement documents.'],
  ['business_practices', 'Modern business practices', 'Document current digital operating practices and improvement priorities.'],
];

function parseProfile(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || '{}'));
  } catch {
    return {};
  }
}

function isPresent(value) {
  return value === true || (typeof value === 'string' && value.trim().length > 0);
}

function hasDigitalPresence(profile) {
  return isPresent(profile.website) && isPresent(profile.domain) && isPresent(profile.ssl);
}

function hasCurrentPractices(profile) {
  return isPresent(profile.business_practices) && profile.business_practices !== 'outdated';
}

function triggerModernizationScan(clientId, options = {}) {
  const getClient = options.getClient || getClientById;
  return Promise.resolve(getClient(clientId, options.databasePath)).then((client) => {
    if (!client) throw new Error(`Client ${clientId} was not found`);

    const profile = parseProfile(client.modernization_profile);
    const evidence = {
      digital_presence: hasDigitalPresence(profile),
      cloud_adoption: isPresent(profile.cloud_adoption),
      automation: isPresent(profile.automation),
      cybersecurity: isPresent(profile.cybersecurity),
      procurement_readiness: isPresent(profile.procurement_readiness),
      business_practices: hasCurrentPractices(profile),
    };
    const gaps = ASSESSMENTS.filter(([key]) => !evidence[key]).map(([key, label]) => ({ key, label }));
    const recommendations = ASSESSMENTS
      .filter(([key]) => !evidence[key])
      .map(([, , recommendation]) => recommendation);
    const score = Math.round(((ASSESSMENTS.length - gaps.length) / ASSESSMENTS.length) * 100);

    return {
      clientId: Number(clientId),
      status: INTELLIGENCE_LIFECYCLE_STATES.COMPLETED,
      score,
      readiness: score < 40 ? 'low' : score < 75 ? 'medium' : 'high',
      gaps,
      recommendations,
    };
  });
}

function updateDashboardModules(moduleStates, modernizationResult) {
  return {
    ...moduleStates,
    modernization: {
      state: modernizationResult.status,
      status: 'Completed',
      placeholder: '',
      summary: [
        { label: 'readiness', value: modernizationResult.readiness },
        { label: 'score', value: `${modernizationResult.score}/100` },
        { label: 'gaps', value: String(modernizationResult.gaps.length) },
      ],
      result: modernizationResult,
    },
  };
}

module.exports = {
  triggerModernizationScan,
  updateDashboardModules,
};