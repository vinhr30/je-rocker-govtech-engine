const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function loadScheduleConfig(rootDir) {
  const configPath = path.join(rootDir, 'core', 'scheduler', 'schedule_config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function resolvePython(rootDir, configuredPython) {
  if (configuredPython) return configuredPython;
  const localPython = path.join(rootDir, '.venv', 'bin', 'python');
  return fs.existsSync(localPython) ? localPython : '/usr/bin/python3';
}

function startGneScheduler({
  rootDir = path.resolve(__dirname, '..'),
  pythonBin,
  spawnProcess = spawn,
  restartDelayMs = 1000,
  logger = console,
} = {}) {
  const config = loadScheduleConfig(rootDir);
  let child = null;
  let restartTimer = null;
  let stopping = false;

  const supervisor = {
    enabled: config.enabled === true,
    get child() { return child; },
    stop() {
      stopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      if (child && !child.killed) child.kill('SIGTERM');
      child = null;
    },
  };

  if (!supervisor.enabled) {
    logger.info('[gne-scheduler] disabled');
    return supervisor;
  }

  const launch = () => {
    if (stopping) return;
    const schedulerPath = path.join(rootDir, 'core', 'scheduler', 'gne_scheduler.py');
    child = spawnProcess(resolvePython(rootDir, pythonBin), [schedulerPath], {
      cwd: rootDir,
      env: { ...process.env, PYTHONPATH: rootDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.info(`[gne-scheduler] started pid=${child.pid || 'pending'}`);
    child.stdout?.on('data', (chunk) => logger.info(`[gne-scheduler] ${String(chunk).trim()}`));
    child.stderr?.on('data', (chunk) => logger.error(`[gne-scheduler] ${String(chunk).trim()}`));
    child.once('error', (error) => logger.error(`[gne-scheduler] process error: ${error.message}`));
    child.once('exit', (code, signalName) => {
      child = null;
      if (stopping) return;
      logger.error(`[gne-scheduler] exited code=${code} signal=${signalName || 'none'}; restarting`);
      restartTimer = setTimeout(launch, restartDelayMs);
    });
  };

  launch();
  return supervisor;
}

module.exports = { loadScheduleConfig, resolvePython, startGneScheduler };
