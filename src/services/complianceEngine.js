const { getClientById } = require('../utils/db');
const { INTELLIGENCE_LIFECYCLE_STATES } = require('./intelligenceActivationController');

function isProvided(value) {
  return String(value || '').trim().length > 0;
}

function isRegistered(value) {
  return ['active', 'registered', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function createCheck(label, complete) {
  return {
    label,
    state: complete ? 'complete' : 'missing',
    missing: !complete,
  };
}

async function triggerComplianceScan(clientId, options = {}) {
  const getClient = options.getClient || getClientById;
  const client = await getClient(clientId, options.databasePath);
  if (!client) {
    throw new Error(`Client ${clientId} was not found`);
  }

  const checks = {
    sam_registration: createCheck('SAM.gov registration', isRegistered(client.sam_registration)),
    uei: createCheck('UEI', isProvided(client.uei)),
    naics: createCheck('NAICS codes', isProvided(client.naics)),
    business_classifications: createCheck('Business classifications', isProvided(client.business_classifications)),
  };
  const missing = Object.entries(checks)
    .filter(([, check]) => check.missing)
    .map(([field]) => field);

  return {
    clientId: Number(clientId),
    state: INTELLIGENCE_LIFECYCLE_STATES.COMPLETED,
    checks,
    summary: {
      ready: missing.length === 0,
      missing,
      issueCount: missing.length,
    },
  };
}

function updateDashboardModules(moduleStates, complianceResult) {
  return {
    ...moduleStates,
    compliance: {
      state: complianceResult.state,
      status: 'Completed',
      placeholder: '',
      summary: Object.values(complianceResult.checks || {}).map((check) => ({
        label: check.label,
        value: check.missing ? 'Missing' : 'Complete',
      })),
      result: complianceResult,
    },
  };
}

module.exports = {
  triggerComplianceScan,
  updateDashboardModules,
};