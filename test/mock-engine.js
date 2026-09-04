#!/usr/bin/env node
// Fake Codex CLI for AgentLoop end-to-end tests.
const fs = require('node:fs');
const path = require('node:path');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendNdjson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function emitJsonl(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sleep(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.trunc(n));
}

function pickStep(list, index) {
  if (!Array.isArray(list) || !list.length) {
    return null;
  }
  return index < list.length ? list[index] : list[list.length - 1];
}

function nextIndex(stateDir, name) {
  const file = path.join(stateDir, `${name}-index.json`);
  const current = loadJson(file, { n: 0 });
  const n = Number(current.n) || 0;
  writeJson(file, { n: n + 1 });
  return n;
}

const DEFAULT_BODIES = {
  'add.js': 'module.exports = { add(a, b) { return a + b; } };\n',
  'sub.js': 'module.exports = { sub(a, b) { return a - b; } };\n',
  'mul.js': 'module.exports = { mul(a, b) { return a * b; } };\n',
};

function defaultBody(name) {
  if (DEFAULT_BODIES[name]) {
    return DEFAULT_BODIES[name];
  }
  const base = path.basename(name);
  if (DEFAULT_BODIES[base]) {
    return DEFAULT_BODIES[base];
  }
  return 'module.exports = {};\n';
}

function updateStateMd(files) {
  const statePath = path.join(process.cwd(), 'STATE.md');
  const existing = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const stamp = `- Mock worker updated ${files.join(', ')} at ${new Date().toISOString()}`;
  const next = existing.includes('## Notes')
    ? existing.replace(/## Notes\n/, `## Notes\n\n${stamp}\n`)
    : `${existing.trim()}\n\n## Notes\n\n${stamp}\n`;
  fs.writeFileSync(statePath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
}

function applyWorkerStep(step) {
  if (!step || step.noChange) {
    return { changed: false, files: [], summary: 'no files written' };
  }

  const files = [];

  if (typeof step.write === 'string' && step.write) {
    const body = step.contents != null ? String(step.contents) : defaultBody(step.write);
    fs.mkdirSync(path.dirname(path.join(process.cwd(), step.write)), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), step.write), body, 'utf8');
    files.push(step.write);
  }

  if (Array.isArray(step.writes)) {
    for (const entry of step.writes) {
      const name = typeof entry === 'string' ? entry : entry && entry.file;
      if (!name) {
        continue;
      }
      const body = entry && entry.contents != null ? String(entry.contents) : defaultBody(name);
      fs.mkdirSync(path.dirname(path.join(process.cwd(), name)), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), name), body, 'utf8');
      files.push(name);
    }
  }

  if (typeof step.append === 'string' && step.append) {
    fs.appendFileSync(
      path.join(process.cwd(), step.append),
      step.appendText != null ? String(step.appendText) : `\n// updated ${new Date().toISOString()}\n`,
      'utf8',
    );
    files.push(step.append);
  }

  if (files.length && step.touchState !== false) {
    updateStateMd(files);
  }

  return {
    changed: files.length > 0,
    files,
    summary: files.length ? `wrote ${files.join(', ')}` : 'worker produced no file writes',
  };
}

function formatWorkerMessage(step, work) {
  if (step && step.lastMessage != null) {
    return String(step.lastMessage);
  }

  const result = (step && step.loopResult) || {};
  const status = result.status === 'failed' || result.status === 'fail' ? 'failed' : 'done';
  const summary = typeof result.summary === 'string' ? result.summary : work.summary;
  const payload = JSON.stringify({ status, summary });

  return [
    'Mock worker finished.',
    summary,
    `LOOP_RESULT ${payload}`,
  ].join('\n');
}

function formatCriticMessage(step) {
  if (step && step.lastMessage != null) {
    return String(step.lastMessage);
  }

  const raw = typeof step === 'string' ? step : (step.verdict || step.text || 'PASS');
  const line = String(raw).startsWith('VERDICT:') ? String(raw) : `VERDICT: ${raw}`;
  return ['Mock critic finished.', line].join('\n');
}

function findPointer() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'current-scenario.json');
    if (fs.existsSync(candidate)) {
      return loadJson(candidate, null);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

function scenarioPath() {
  if (process.env.AGENTLOOP_MOCK_SCENARIO) {
    return process.env.AGENTLOOP_MOCK_SCENARIO;
  }
  const flagged = argValue('--scenario');
  if (flagged) {
    return flagged;
  }
  const pointer = findPointer();
  if (pointer && pointer.scenario) {
    return pointer.scenario;
  }
  return null;
}

function resolveScenario(file) {
  const loaded = file ? loadJson(file, {}) : {};
  return loaded && typeof loaded === 'object' ? loaded : {};
}

function resolveStateDir(scenarioFile) {
  if (process.env.AGENTLOOP_MOCK_STATE) {
    return process.env.AGENTLOOP_MOCK_STATE;
  }
  const pointer = findPointer();
  if (pointer && pointer.state) {
    return pointer.state;
  }
  return path.join(path.dirname(scenarioFile || '.'), '.mock-state');
}

const prompt = readStdin();
const outputPath = argValue('--output-last-message');
const model = argValue('--model');
const scenarioFile = scenarioPath();
const scenario = resolveScenario(scenarioFile);
const engine = scenario.engine && typeof scenario.engine === 'object' ? scenario.engine : {};
const stateDir = resolveStateDir(scenarioFile);
fs.mkdirSync(stateDir, { recursive: true });

// Role detection couples to the critic prompt wording in src/prompts.js; changing that wording silently makes the mock grade as a worker.
const isCritic = /strict project critic/i.test(prompt);
const role = isCritic ? 'critic' : 'worker';
const invocation = {
  ts: new Date().toISOString(),
  role,
  cwd: process.cwd(),
  model,
  outputPath,
  argv: process.argv.slice(2),
  scenario: scenarioFile,
};

try {
  emitJsonl({ type: 'thread.started', text: `mock ${role} session started` });
  emitJsonl({
    type: 'item.completed',
    item: { type: 'command_execution', command: `mock ${role}` },
  });

  let lastMessage = '';
  let step = null;

  if (isCritic) {
    const index = nextIndex(stateDir, 'critic');
    const raw = pickStep(engine.critic, index);
    step = raw && typeof raw === 'object' ? raw : { verdict: raw };
    sleep(step.latencyMs || engine.latencyMs);
    lastMessage = formatCriticMessage(step);
    invocation.verdict = lastMessage.split('\n').pop();
    invocation.index = index;
  } else {
    const index = nextIndex(stateDir, 'worker');
    step = pickStep(engine.worker, index) || {};
    sleep(step.latencyMs || engine.latencyMs);
    const work = applyWorkerStep(step);
    lastMessage = formatWorkerMessage(step, work);
    invocation.summary = work.summary;
    invocation.changed = work.changed;
    invocation.files = work.files;
    invocation.index = index;
  }

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, lastMessage, 'utf8');
  }

  emitJsonl({
    type: 'item.completed',
    item: { type: 'agent_message', text: lastMessage.split('\n')[0] },
  });

  invocation.ok = true;
  appendNdjson(path.join(stateDir, 'invocations.ndjson'), invocation);
  process.exit(step && Number.isInteger(step.exitCode) ? step.exitCode : 0);
} catch (error) {
  invocation.ok = false;
  invocation.error = error.message;
  appendNdjson(path.join(stateDir, 'invocations.ndjson'), invocation);
  process.stderr.write(`mock-engine failed: ${error.message}\n`);
  process.exit(1);
}
