const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { triggerModernizationScan, updateDashboardModules } = require('../src/services/modernizationEngine');

test('modernization engine returns a structured completed result for missing evidence', async () => {
  const result = await triggerModernizationScan(7, { getClient: async () => ({ id: 7, modernization_profile: '{}' }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.score, 0);
  assert.equal(result.readiness, 'low');
  assert.equal(result.gaps.length, 6);
  assert.equal(result.recommendations.length, 6);
});

test('modernization engine scores complete profile readiness', async () => {
  const result = await triggerModernizationScan(8, {
    getClient: async () => ({
      id: 8,
      modernization_profile: JSON.stringify({
        website: 'https://example.com', domain: 'example.com', ssl: true,
        cloud_adoption: 'Microsoft 365', automation: 'CRM workflows',
        cybersecurity: 'MFA', procurement_readiness: 'Capability statement',
        business_practices: 'current',
      }),
    }),
  });
  assert.equal(result.score, 100);
  assert.equal(result.readiness, 'high');
  assert.deepEqual(result.gaps, []);
});

test('dashboard update completes only modernization', () => {
  const result = { status: 'completed', score: 50, readiness: 'medium', gaps: [{ key: 'automation' }] };
  const update = updateDashboardModules({ forecasting: 'pending', match: 'pending', mission: 'pending', pulse: 'pending' }, result);
  assert.equal(update.modernization.status, 'Completed');
  assert.equal(update.modernization.placeholder, '');
  assert.deepEqual(
    Object.fromEntries(Object.entries(update).filter(([key]) => key !== 'modernization')),
    { forecasting: 'pending', match: 'pending', mission: 'pending', pulse: 'pending' }
  );
});

test('dashboard modernization panel remains pending and does not trigger the scan', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src/pages/ClientDashboardPage.jsx'), 'utf8');
  assert.match(dashboard, /Modernization Panel/);
  assert.match(dashboard, /Modernization review is pending\./);
  assert.doesNotMatch(dashboard, /triggerModernizationScan/);
});