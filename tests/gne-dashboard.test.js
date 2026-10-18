const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function extractArrayDefault(componentSource, propName) {
  return new RegExp(`\\{[^}]*${propName}\\s*=\\s*\\[\\]`).test(componentSource);
}

test('GNE route and navigation item are registered', () => {
  const routes = read('dashboard/routes/index.jsx');
  const navigation = read('dashboard/navigation/NavItems.js');
  const server = read('server.js');

  assert.match(routes, /path:\s*['"]\/grant-neural-engine['"]/);
  assert.match(routes, /GrantNeuralEnginePage/);
  assert.match(navigation, /label:\s*['"]Grant Neural Engine['"]/);
  assert.match(navigation, /path:\s*['"]\/grant-neural-engine['"]/);
  assert.match(server, /app\.get\(['"]\/grant-neural-engine['"]/);
  assert.match(server, /href="\/grant-neural-engine"/);
});

test('GNE page renders every requested panel component', () => {
  const page = read('dashboard/pages/grant_neural_engine.jsx');
  for (const panel of ['GneSummaryPanel', 'GneSignalsTable', 'GneForecastPanel', 'GneModernizationPanel', 'GnePartnersPanel']) {
    assert.match(page, new RegExp(`<${panel}\\b`));
  }
  for (const key of ['signals', 'semantics', 'classifications', 'forecasts', 'modernization', 'partners']) {
    assert.match(page, new RegExp(`${key}: \\[\\]`));
  }
});

test('GNE API exposes all six state accessors', () => {
  const api = read('core/api/gne_api.js');
  for (const accessor of ['getGneSignals', 'getGneSemantics', 'getGneClassifications', 'getGneForecasts', 'getGneModernization', 'getGnePartners']) {
    assert.match(api, new RegExp(`export const ${accessor}`));
  }
  assert.match(api, /\/api\/gne\/state/);
  assert.match(read('server.js'), /app\.get\(['"]\/api\/gne\/state['"]/);
  assert.match(api, /export async function refreshGne/);
  assert.match(read('server.js'), /app\.post\(['"]\/api\/gne\/refresh['"]/);
  assert.match(read('server.js'), /id="gne-refresh"/);
});

test('GNE cockpit paginates large result layers without truncating API data', () => {
  const server = read('server.js');
  assert.match(server, /const PAGE_SIZE = 50/);
  assert.match(server, /const renderPaged =/);
  for (const panelId of ['gne-signals', 'gne-forecasts', 'gne-modernization', 'gne-partners']) {
    assert.match(server, new RegExp(`renderPaged\\('${panelId}'`));
  }
  assert.match(server, /start \+ index/);
  assert.match(server, /data-gne-prev/);
  assert.match(server, /data-gne-next/);
});

test('GNE panels guard empty arrays with explicit empty states', () => {
  const components = [
    ['dashboard/components/gne/GneSummaryPanel.jsx', 'signals'],
    ['dashboard/components/gne/GneSignalsTable.jsx', 'signals'],
    ['dashboard/components/gne/GneForecastPanel.jsx', 'forecasts'],
    ['dashboard/components/gne/GneModernizationPanel.jsx', 'modernization'],
    ['dashboard/components/gne/GnePartnersPanel.jsx', 'partners'],
  ];
  for (const [componentPath, propName] of components) {
    const source = read(componentPath);
    assert.ok(extractArrayDefault(source, propName), `${componentPath} defaults ${propName} to []`);
  }
  assert.match(read('dashboard/components/gne/GneSignalsTable.jsx'), /No grant signals available/);
});

test('GNE Python snapshot exposes arrays for every dashboard layer', () => {
  const result = spawnSync('/usr/bin/python3', ['core/api/gne_snapshot.py'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  const keys = ['gne_signals', 'gne_semantics', 'gne_classifications', 'gne_forecasts', 'gne_modernization', 'gne_partners'];
  assert.deepStrictEqual(Object.keys(snapshot).sort(), keys.sort());
  for (const key of keys) assert.ok(Array.isArray(snapshot[key]), `${key} is an array`);
});
