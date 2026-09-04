// Harness runner: boots the daemon, executes loop scenarios, and asserts results.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.join(REPO_ROOT, 'workspace');
const FIXTURES = path.join(__dirname, 'fixtures', 'project');
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const DEFAULT_PORT = 5761;
const PORT = Number(process.env.AGENTLOOP_HARNESS_PORT || DEFAULT_PORT);
const BRIDGE_PORT = PORT + 1;
const HOST = '127.0.0.1';
const MOCK_CMD = path.join(__dirname, 'mock-engine.cmd');
const MOCK_JS = path.join(__dirname, 'mock-engine.js');
const MOCK_EXECUTABLE = process.platform === 'win32' ? MOCK_CMD : MOCK_JS;

const TERMINAL_STATUSES = new Set([
  'done', 'failed', 'cancelled', 'passed', 'maxed', 'partial', 'incomplete', 'plan_complete',
]);

let originalConfigContent = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: urlPath,
      method,
      headers: data ? {
        'content-type': 'application/json',
        'content-length': data.length,
      } : {},
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let value = text;
        try { value = text ? JSON.parse(text) : null; } catch { /* text fallback */ }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: value, raw: text });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function writePlan(dir, items) {
  const lines = ['# Plan', '', 'Build small CommonJS modules, one increment per cycle.', ''];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item}`);
  });
  lines.push('');
  fs.writeFileSync(path.join(dir, 'PLAN.md'), `${lines.join('\n')}\n`);
}

function seedProject(name, scenario) {
  const dir = path.join(WORKSPACE, name);
  rmrf(dir);
  copyTree(FIXTURES, dir);
  if (Array.isArray(scenario.plan) && scenario.plan.length) {
    writePlan(dir, scenario.plan);
  }
  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.email', 'harness@agentloop.local']);
  runGit(dir, ['config', 'user.name', 'AgentLoop Harness']);
  runGit(dir, ['add', '-A']);
  const commit = runGit(dir, ['commit', '-m', `initial: ${name}`]);
  if (commit.status !== 0) {
    throw new Error(`git commit failed in ${dir}: ${commit.stderr || commit.stdout}`);
  }
  return dir;
}

function readNdjson(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function daemonAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForReady(timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const state = await request('GET', '/api/state');
      if (state.statusCode === 200 && state.body && state.body.daemon) {
        return state;
      }
    } catch {
      // daemon booting
    }
    await sleep(100);
  }
  throw new Error(`daemon on ${PORT} did not become ready`);
}

async function waitForLoop(id, timeoutMs = 45000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const state = await request('GET', '/api/state');
    last = state;
    const tasks = state.body && state.body.tasks ? state.body.tasks : {};
    const running = Array.isArray(tasks.running) ? tasks.running : [];
    const recent = Array.isArray(tasks.recent) ? tasks.recent : [];
    const pending = Array.isArray(tasks.pending) ? tasks.pending : [];
    const foundRecent = recent.find((task) => task.id === id);
    const foundRunning = running.find((task) => task.id === id);
    const foundPending = pending.find((task) => task.id === id);
    if (foundRecent && !foundRunning && !foundPending && TERMINAL_STATUSES.has(foundRecent.status)) {
      return { done: true, state, foundRecent, elapsedMs: Date.now() - started };
    }
    await sleep(100);
  }
  return { done: false, state: last, foundRecent: null, elapsedMs: Date.now() - started };
}

function restoreConfig() {
  if (originalConfigContent !== null) {
    const configPath = path.join(REPO_ROOT, 'config.json');
    try {
      fs.writeFileSync(configPath, originalConfigContent, 'utf8');
    } catch {
      // best-effort restore
    }
  }
}

process.on('exit', restoreConfig);
process.on('SIGINT', () => {
  restoreConfig();
  process.exit(130);
});

async function startDaemon() {
  const configPath = path.join(REPO_ROOT, 'config.json');
  if (originalConfigContent === null) {
    originalConfigContent = fs.readFileSync(configPath, 'utf8');
  }

  const testConfig = {
    dashboardPort: PORT,
    maxConcurrent: 1,
    taskTimeoutMin: 5,
    defaultEngine: 'codex',
    mcpBridge: { port: BRIDGE_PORT },
    models: { codex: 'gpt-5.6-terra' },
    enginePaths: { codex: MOCK_EXECUTABLE },
  };

  fs.writeFileSync(configPath, `${JSON.stringify(testConfig, null, 2)}\n`, 'utf8');

  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'src', 'daemon.js')], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: 'ignore',
  });

  try {
    await waitForReady();
  } catch (error) {
    stopDaemon(child);
    throw error;
  } finally {
    // Config loaded into daemon memory; restore disk copy so repo stays clean.
    restoreConfig();
  }

  return child;
}

function stopDaemon(child) {
  restoreConfig();
  if (!child || !child.pid) {
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* exited */ }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && daemonAlive(child.pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (daemonAlive(child.pid)) {
    try { child.kill('SIGKILL'); } catch { /* exited */ }
  }
}

function cleanWorkspace() {
  if (!fs.existsSync(WORKSPACE)) {
    return;
  }
  const entries = fs.readdirSync(WORKSPACE);
  for (const entry of entries) {
    rmrf(path.join(WORKSPACE, entry));
  }
}

function collectActual(id, projectDir, mockState, waited, child) {
  const events = readNdjson(path.join(REPO_ROOT, 'state', 'events.ndjson'));
  const invocations = readNdjson(path.join(mockState, 'invocations.ndjson'));
  const recent = waited.foundRecent || {};
  const verdicts = events
    .filter((event) => event.id === id && event.type === 'critic_verdict')
    .map((event) => event.verdict);
  const gitLog = runGit(projectDir, ['log', '--oneline', '--decorate']);
  const gitStatus = runGit(projectDir, ['status', '--porcelain']);
  const checkpointCommits = gitLog.stdout.split('\n').filter((line) => line.includes('wip(loop):'));

  return {
    status: recent.status || null,
    summary: recent.summary || '',
    reason: recent.reason || null,
    checkpoints: checkpointCommits.length,
    checkpointCommits,
    tasksDone: recent.tasksDone || 0,
    tasksBlocked: recent.tasksBlocked || 0,
    verdicts,
    criticCount: invocations.filter((row) => row.role === 'critic').length,
    workerCount: invocations.filter((row) => row.role === 'worker').length,
    daemonAlive: daemonAlive(child.pid),
    gitLog: gitLog.stdout,
    gitStatus: gitStatus.stdout,
    elapsedMs: waited.elapsedMs,
  };
}

async function runScenario(scenarioName, child) {
  const scenarioFile = path.join(SCENARIOS_DIR, `${scenarioName}.json`);
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  const name = scenario.name || scenarioName;
  const mockState = path.join(WORKSPACE, 'mock-state', name);
  rmrf(mockState);
  fs.mkdirSync(mockState, { recursive: true });

  const projectDir = seedProject(name, scenario);

  fs.writeFileSync(path.join(WORKSPACE, 'current-scenario.json'), `${JSON.stringify({
    scenario: scenarioFile,
    state: mockState,
  }, null, 2)}\n`);

  const started = await request('POST', '/api/loop', {
    project: projectDir,
    maxCycles: scenario.maxCycles,
    taskRetries: scenario.taskRetries,
    engine: 'codex',
    autoCommit: scenario.autoCommit !== false,
  });

  if (started.statusCode < 200 || started.statusCode >= 300 || !started.body || !started.body.id) {
    throw new Error(`POST /api/loop failed: ${started.statusCode} ${started.raw}`);
  }

  const id = started.body.id;
  const waited = await waitForLoop(id);
  if (!waited.done) {
    throw new Error(`Loop ${id} did not reach terminal status within timeout`);
  }

  const actual = collectActual(id, projectDir, mockState, waited, child);
  return { actual, expect: scenario.expect, scenario };
}

module.exports = {
  startDaemon,
  stopDaemon,
  runScenario,
  cleanWorkspace,
  PORT,
};
