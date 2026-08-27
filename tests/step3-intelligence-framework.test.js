const assert = require('assert');
const test = require('node:test');

const {
  ENGINE_TRIGGER_MAP,
  INTELLIGENCE_LIFECYCLE_STATES,
  activateIntelligence,
  createIntelligenceResultContract,
} = require('../src/services/intelligenceActivationController');

test('activation controller declares all engines without executing them', () => {
  assert.deepEqual(Object.keys(ENGINE_TRIGGER_MAP), [
    'compliance',
    'modernization',
    'forecasting',
    'match',
    'mission',
    'pulse',
  ]);
  assert.deepEqual(Object.values(INTELLIGENCE_LIFECYCLE_STATES), [
    'pending',
    'running',
    'completed',
    'failed',
  ]);
});

test('activation creates a pending lifecycle and null intelligence results', () => {
  const activation = activateIntelligence(42);
  assert.equal(activation.clientId, 42);
  assert.deepEqual(activation.result, createIntelligenceResultContract());
  assert.ok(Object.values(activation.result).every((value) => value === null));
  assert.ok(Object.values(activation.lifecycle).every((engine) => engine.state === 'pending'));
  assert.equal(activation.dashboardUpdate.active, false);
  assert.ok(Object.values(activation.dashboardUpdate.moduleStates).every((state) => state === 'pending'));
  assert.equal(activation.dashboardUpdate.moduleStates.compliance, 'pending');
});

test('activation requires a valid client id', () => {
  assert.throws(() => activateIntelligence(), /valid clientId/);
  assert.throws(() => activateIntelligence(0), /valid clientId/);
});