const INTELLIGENCE_LIFECYCLE_STATES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const ENGINE_TRIGGER_MAP = Object.freeze({
  compliance: Object.freeze({ module: 'weekly', trigger: 'client_created' }),
  modernization: Object.freeze({ module: 'opportunities', trigger: 'client_created' }),
  forecasting: Object.freeze({ module: 'spend', trigger: 'client_created' }),
  match: Object.freeze({ module: 'matches', trigger: 'client_created' }),
  mission: Object.freeze({ module: 'vendors', trigger: 'client_created' }),
  pulse: Object.freeze({ module: 'capture', trigger: 'client_created' }),
});

function createIntelligenceResultContract() {
  return {
    compliance: null,
    modernization: null,
    forecasting: null,
    match: null,
    mission: null,
    pulse: null,
  };
}

function buildPendingDashboardUpdate(clientId) {
  return {
    clientId,
    active: false,
    moduleStates: Object.values(ENGINE_TRIGGER_MAP).reduce((modules, engine) => {
      modules[engine.module] = INTELLIGENCE_LIFECYCLE_STATES.PENDING;
      return modules;
    }, {}),
  };
}

function activateIntelligence(clientId) {
  if (!Number.isInteger(Number(clientId)) || Number(clientId) <= 0) {
    throw new TypeError('A valid clientId is required');
  }

  const normalizedClientId = Number(clientId);
  const lifecycle = Object.keys(ENGINE_TRIGGER_MAP).reduce((engines, engineName) => {
    engines[engineName] = {
      clientId: normalizedClientId,
      state: INTELLIGENCE_LIFECYCLE_STATES.PENDING,
      trigger: ENGINE_TRIGGER_MAP[engineName].trigger,
    };
    return engines;
  }, {});

  return {
    clientId: normalizedClientId,
    lifecycle,
    result: createIntelligenceResultContract(),
    dashboardUpdate: buildPendingDashboardUpdate(normalizedClientId),
  };
}

module.exports = {
  ENGINE_TRIGGER_MAP,
  INTELLIGENCE_LIFECYCLE_STATES,
  activateIntelligence,
  buildPendingDashboardUpdate,
  createIntelligenceResultContract,
};