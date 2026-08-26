// Daemon scheduler, worker runner, and local HTTP API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const store = require('./store');
const engines = require('./engines');
const state = require('./state');
const {
  taskPrompt,
  loopWorkerPrompt,
  polishWorkerPrompt,
  criticPrompt,
  polishCriticPrompt,
  parseLoopResult,
  parseCriticVerdict,
  parsePlanTasks,
  parsePolishVerdict,
} = require('./prompts');

const pollMs = 1500;
const maxResultText = 20000;
const maxLogLines = 1000;
const maxEventBytes = 16 * 1024;
const maxDigestBytes = 1024 * 1024;
const knownEngines = new Set(engines.ids());
const messageKinds = new Set(['info', 'question', 'results']);
const terminalTaskStatuses = new Set(['done', 'failed', 'cancelled', 'passed', 'maxed', 'partial', 'incomplete', 'plan_complete']);
const dirtyTreeError = 'Auto-checkpoint needs a clean project tree: commit or stash your changes first.';
const defaultLoopCycles = 3;
const defaultTaskRetries = 3;
const runningActivity = new Map();
const activeWorkers = new Map();

let daemonInfo;
let server;
let ticker;
let stopping = false;
let bridgeChild;

function taskTime(task, field) {
  const value = Date.parse(task[field]);
  return Number.isFinite(value) ? value : 0;
}

function taskPriority(task) {
  const value = Number(task.priority);
  return Number.isFinite(value) ? value : 5;
}

function sortPending(tasks) {
  return tasks.sort((left, right) => (
    taskPriority(left) - taskPriority(right)
    || taskTime(left, 'createdAt') - taskTime(right, 'createdAt')
  ));
}

function trimResult(text) {
  const value = String(text || '').trim();
  return value.length > maxResultText ? value.slice(-maxResultText) : value;
}

function recordActivity(id, engine, line) {
  const parsed = engine.parseLine(line) || {};
  const text = String(parsed.text || '').trim();

  if (text) {
    const previous = runningActivity.get(id);
    runningActivity.set(id, {
      ts: new Date().toISOString(),
      text: text.slice(0, 500),
      toolCalls: (previous && previous.toolCalls ? previous.toolCalls : 0) + (parsed.tool ? 1 : 0),
    });
  }

  return parsed;
}

function recordEvent(type, data) {
  try {
    store.appendEvent(type, data);
  } catch (error) {
    console.error(`Failed to append ${type} event: ${error.message}`);
  }
}

function streamLines(stream, onLine) {
  let buffered = '';
  stream.setEncoding('utf8');

  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();

    for (const line of lines) {
      onLine(line.replace(/\r$/, ''));
    }
  });

  stream.on('end', () => {
    if (buffered) {
      onLine(buffered.replace(/\r$/, ''));
    }
  });
}

function spawnEngine(engine, args, options) {
  const executable = engines.binary(engine, store.config.enginePaths);

  if (!executable) {
    throw new Error(`${engine.label} CLI not found on PATH. Install it (${engine.installHint}) and restart the daemon.`);
  }

  const settings = engine.env ? { ...options, env: engine.env(process.env) } : options;

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', executable, ...args], settings);
  }

  return spawn(executable, args, settings);
}

function taskkillPath() {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(windowsRoot, 'System32', 'taskkill.exe');
}

function terminateWorker(child) {
  if (!child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      const killer = spawnSync(taskkillPath(), ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });

      if (killer.status !== 0) {
        child.kill('SIGKILL');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
      }
    }
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
  }
}

function stopWorker(child) {
  if (!child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      spawnSync(taskkillPath(), ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
    }
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
  }
}

function bridgePort() {
  const port = Number(store.config.mcpBridge?.port);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 5758;
}

function readBridgeHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(store.paths.bridge, 'utf8'));
  } catch {
    return null;
  }
}

function clearBridgeHeartbeat(pid) {
  const heartbeat = readBridgeHeartbeat();

  if (pid && heartbeat && heartbeat.pid !== pid) {
    return;
  }

  try {
    fs.unlinkSync(store.paths.bridge);
  } catch {
  }
}

function bridgeRunning() {
  return store.isAlive(readBridgeHeartbeat());
}

function recoverBridgeHeartbeat() {
  const heartbeat = readBridgeHeartbeat();

  if (heartbeat && !store.isAlive(heartbeat)) {
    clearBridgeHeartbeat(heartbeat.pid);
  }
}

function readBridgeToken() {
  try {
    const token = fs.readFileSync(store.paths.mcpToken, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

const quickTunnelPorts = [20241, 20242, 20243, 20244, 20245];
const quickTunnelProbeMs = 400;

function probeQuickTunnelPort(port) {
  return new Promise((resolve) => {
    let settled = false;
    let req;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      resolve(value);
    };
    const wall = setTimeout(() => {
      try { req.destroy(); } catch { /* already closed */ }
      done(null);
    }, quickTunnelProbeMs);

    req = http.get({
      host: '127.0.0.1',
      port,
      path: '/quicktunnel',
      timeout: quickTunnelProbeMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) {
          req.destroy();
          done(null);
        }
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const raw = typeof data?.hostname === 'string' ? data.hostname.trim() : '';
          if (!raw) {
            done(null);
            return;
          }
          if (raw.includes('://')) {
            done(new URL(raw).hostname || null);
            return;
          }
          done(raw.replace(/\/+$/, '') || null);
        } catch {
          done(null);
        }
      });
    });
    req.on('error', () => done(null));
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
  });
}

async function detectQuickTunnelHostname() {
  const results = await Promise.all(quickTunnelPorts.map(probeQuickTunnelPort));
  return results.find((hostname) => hostname) || null;
}

async function bridgeDetails() {
  const port = bridgePort();
  const token = readBridgeToken();
  const localEndpoint = `http://127.0.0.1:${port}/mcp`;
  const connectorUrl = token ? `${localEndpoint}?key=${encodeURIComponent(token)}` : localEndpoint;
  const hostname = await detectQuickTunnelHostname();
  const publicUrl = hostname
    ? (token ? `https://${hostname}/mcp?key=${encodeURIComponent(token)}` : `https://${hostname}/mcp`)
    : null;

  return {
    running: bridgeRunning(),
    port,
    localEndpoint,
    connectorUrl,
    publicUrl,
    token,
  };
}

function startBridge() {
  if (bridgeRunning()) {
    return true;
  }

  recoverBridgeHeartbeat();

  if (bridgeChild && bridgeChild.exitCode === null && !bridgeChild.killed) {
    return true;
  }

  try {
    const child = spawn(process.execPath, [path.join(store.paths.root, 'bridge.js')], {
      cwd: store.paths.root,
      stdio: 'ignore',
      windowsHide: true,
    });

    bridgeChild = child;
    child.unref();
    child.once('error', (error) => {
      console.error(`Bridge failed to start: ${error.message}`);
      if (bridgeChild === child) {
        bridgeChild = undefined;
      }
    });
    child.once('exit', () => {
      clearBridgeHeartbeat(child.pid);
      if (bridgeChild === child) {
        bridgeChild = undefined;
      }
    });
    return true;
  } catch (error) {
    console.error(`Bridge failed to start: ${error.message}`);
    return false;
  }
}

function stopBridge() {
  const heartbeat = readBridgeHeartbeat();

  if (!store.isAlive(heartbeat)) {
    recoverBridgeHeartbeat();
    return false;
  }

  const child = bridgeChild && bridgeChild.pid === heartbeat.pid
    ? bridgeChild
    : {
      pid: heartbeat.pid,
      kill(signal) {
        process.kill(this.pid, signal);
      },
    };

  terminateWorker(child);
  clearBridgeHeartbeat(heartbeat.pid);
  if (bridgeChild === child) {
    bridgeChild = undefined;
  }
  return true;
}

function readWorkerOutput(outputPath, fallback) {
  try {
    const output = fs.readFileSync(outputPath, 'utf8');
    return output.trim() ? output : fallback;
  } catch {
    return fallback;
  } finally {
    try {
      fs.unlinkSync(outputPath);
    } catch {
    }
  }
}

function trackTail(tail, parsed) {
  if (!parsed) {
    return;
  }

  if (typeof parsed.costUsd === 'number') {
    tail.costUsd = parsed.costUsd;
  }

  if (typeof parsed.result === 'string' && parsed.result) {
    tail.result = parsed.result;
    return;
  }

  const text = String(parsed.text || '').trim();

  if (!text) {
    return;
  }

  tail.text = text;

  if (parsed.message) {
    tail.message = text;
  }
}

function finalText(engine, outputPath, tail) {
  const fallback = tail.message || tail.text;

  return engine.usesOutputFile ? readWorkerOutput(outputPath, fallback) : (tail.result || fallback);
}

function timeoutMinutes() {
  const value = Number(store.config.taskTimeoutMin);
  return Number.isFinite(value) ? Math.max(1, value) : 45;
}

function loopCycles(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return defaultLoopCycles;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return defaultLoopCycles;
  }

  return Math.min(50, Math.max(1, Math.trunc(parsed)));
}

function loopRetries(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return defaultTaskRetries;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return defaultTaskRetries;
  }

  return Math.min(10, Math.max(1, Math.trunc(parsed)));
}

function cycleLogId(loopId, cycleNumber, role) {
  return `${loopId}-cycle-${cycleNumber}-${role}`;
}

function readRunningLoop(id) {
  try {
    const loop = store.readTask(id, 'running');
    return loop && loop.type === 'loop' ? loop : null;
  } catch {
    return null;
  }
}

function updateCycle(loop, cycleNumber, fields) {
  const cycles = Array.isArray(loop.cycles) ? loop.cycles : [];

  return {
    ...loop,
    cycles: cycles.map((cycle) => (
      cycle && cycle.n === cycleNumber ? { ...cycle, ...fields } : cycle
    )),
  };
}

function currentCycle(loop, cycleNumber) {
  const cycles = Array.isArray(loop.cycles) ? loop.cycles : [];
  return cycles.find((cycle) => cycle && cycle.n === cycleNumber) || null;
}

// The pass latch: a loop with blocked tasks is never "passed", whatever its cycles say.
function hasPassedCycle(loop) {
  if (Array.isArray(loop.blocked) && loop.blocked.length) {
    return false;
  }

  const cycles = Array.isArray(loop.cycles) ? loop.cycles : [];

  return cycles.some((cycle) => (
    cycle && (cycle.status === 'passed' || cycle.verdict === 'PASS')
  ));
}

function cyclePhase(cycle, phase) {
  return cycle && cycle.phase === 'polish' ? 'polish' : phase;
}

function incompletePolishSummary() {
  return 'The final polish cycle did not finish cleanly; the working tree may hold partial or unreviewed changes.';
}

function workerFailureReason(details, parsed) {
  if (details.timedOut) {
    return 'timed_out';
  }

  if (details.reason) {
    return details.reason;
  }

  if (details.forceFailed) {
    return 'worker_failed';
  }

  if (details.exitCode !== 0 || details.signal) {
    return 'worker_exited_nonzero';
  }

  if (!parsed) {
    return 'invalid_loop_result';
  }

  return parsed.status === 'failed' ? 'worker_reported_failure' : null;
}

function criticFailureReason(details, verdict) {
  if (details.timedOut) {
    return 'critic_timed_out';
  }

  if (details.reason) {
    return details.reason;
  }

  if (details.forceFailed) {
    return 'critic_failed';
  }

  if (details.exitCode !== 0 || details.signal) {
    return 'critic_exited_nonzero';
  }

  return verdict ? null : 'critic_invalid_verdict';
}

function fallbackSummary(text, status, timedOut) {
  if (timedOut) {
    return `Worker timed out after ${timeoutMinutes()} minutes.`;
  }

  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  const lastLine = lines[lines.length - 1];

  if (lastLine) {
    return lastLine.slice(0, 500);
  }

  return status === 'done' ? 'Worker completed.' : 'Worker failed.';
}

function completeTask(task, details) {
  const finishedAt = new Date().toISOString();
  const startedAt = taskTime(task, 'startedAt');
  const parsed = parseLoopResult(details.resultText);
  const cancelled = details.cancelled === true;
  const workerExitedNonzero = !cancelled && !details.forceFailed && !details.timedOut
    && (details.exitCode !== 0 || details.signal);
  const invalidLoopResult = !cancelled && !details.forceFailed && !details.timedOut
    && !workerExitedNonzero && !parsed;
  let reason = null;

  if (cancelled) {
    reason = 'cancelled';
  } else if (details.timedOut) {
    reason = 'timed_out';
  } else if (details.reason) {
    reason = details.reason;
  } else if (details.forceFailed) {
    reason = 'worker_failed';
  } else if (workerExitedNonzero) {
    reason = 'worker_exited_nonzero';
  } else if (invalidLoopResult) {
    reason = 'invalid_loop_result';
  } else if (parsed.status === 'failed') {
    reason = 'worker_reported_failure';
  }

  const status = cancelled ? 'cancelled' : reason ? 'failed' : parsed.status;
  const result = {
    id: task.id,
    status,
    summary: cancelled
      ? 'Cancelled.'
      : details.timedOut
      ? fallbackSummary(details.resultText, status, true)
      : invalidLoopResult
      ? 'worker exited without a valid LOOP_RESULT'
      : parsed && parsed.summary
        ? parsed.summary
        : fallbackSummary(details.resultText, status, details.timedOut),
    resultText: trimResult(details.resultText),
    exitCode: details.exitCode,
    ...(typeof details.costUsd === 'number' ? { costUsd: details.costUsd } : {}),
    ...(reason ? { reason } : {}),
    durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
    finishedAt,
  };
  const completedTask = {
    ...task,
    status,
    finishedAt,
    ...(reason ? { reason } : {}),
  };

  try {
    store.writeResult(result);
    store.writeTask(completedTask, 'running');
    store.moveTask(task.id, 'running', 'done');
    if (status === 'cancelled') {
      recordEvent('cancel', { id: task.id, reason });
    } else if (status === 'failed') {
      recordEvent('fail', { id: task.id, reason, ...(workerExitedNonzero ? { code: details.exitCode } : {}) });
    } else {
      recordEvent('done', { id: task.id, status });
    }
  } catch (error) {
    console.error(`Failed to finish ${task.id}: ${error.message}`);
  } finally {
    runningActivity.delete(task.id);
  }
}

function completeLoop(loop, status, summary, reason) {
  const finishedAt = new Date().toISOString();
  const startedAt = taskTime(loop, 'startedAt');
  const completedLoop = {
    ...loop,
    status,
    summary,
    finishedAt,
    ...(reason ? { reason } : {}),
  };
  let completed = completedLoop;

  try {
    store.writeTask(completed, 'running');
    store.moveTask(loop.id, 'running', 'done');
  } catch (error) {
    console.error(`Failed to finish ${loop.id}: ${error.message}`);
    completed = {
      ...loop,
      status: 'failed',
      summary: 'Loop completion failed.',
      finishedAt,
      reason: 'loop_completion_failed',
    };

    try {
      store.writeTask(completed, 'running');
      store.moveTask(loop.id, 'running', 'done');
    } catch (fallbackError) {
      console.error(`Failed to mark ${loop.id} as failed: ${fallbackError.message}`);
    }
  }

  try {
    const costUsd = state.sumCycleCosts(completed.cycles);

    store.writeResult({
      id: loop.id,
      status: completed.status,
      summary: completed.summary,
      ...(costUsd !== null ? { costUsd } : {}),
      durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
      finishedAt,
      ...(completed.reason ? { reason: completed.reason } : {}),
    });
  } catch (error) {
    console.error(`Failed to write result for ${loop.id}: ${error.message}`);
  }

  recordEvent('loop_ended', {
    id: loop.id,
    status: completed.status,
    ...(completed.reason ? { reason: completed.reason } : {}),
  });

  runningActivity.delete(loop.id);

  return completed;
}

function appendLoopLog(loop, line) {
  try {
    store.appendLogLine(loop.id, line);
  } catch (error) {
    console.error(`Failed to write loop log for ${loop.id}: ${error.message}`);
  }
}

function appendSessionLog(loop, cycle, role, line) {
  const logId = role === 'worker' ? cycle.workerLogId : cycle.criticLogId;

  if (logId) {
    try {
      store.appendLogLine(logId, line);
    } catch (error) {
      console.error(`Failed to write ${role} log for cycle ${cycle.n}: ${error.message}`);
    }
  }

  appendLoopLog(loop, line);
}

function appendSessionResult(loop, cycle, role, resultText) {
  const text = String(resultText || '').trim();

  if (text) {
    appendSessionLog(loop, cycle, role, text);
  }
}

function failLoopTransition(loop, cycleNumber, error) {
  const current = readRunningLoop(loop.id) || loop;
  const cycle = currentCycle(current, cycleNumber);
  const passed = hasPassedCycle(current);
  const finishedAt = new Date().toISOString();
  const startedAt = cycle ? taskTime(cycle, 'startedAt') : taskTime(current, 'startedAt');
  const failed = updateCycle(current, cycleNumber, {
    status: 'failed',
    summary: `Cycle ${cycleNumber} transition failed.`,
    finishedAt,
    durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
    reason: 'cycle_transition_failed',
  });

  completeLoop(
    failed,
    passed ? 'passed' : 'failed',
    passed ? `Passed before polish cycle ${cycleNumber} could finish.` : `Cycle ${cycleNumber} transition failed.`,
    passed ? undefined : 'cycle_transition_failed',
  );
  console.error(`Failed to transition cycle ${cycleNumber} for ${loop.id}: ${error.message}`);
}

function finishLoopSession(loop, cycle, onFinish, details) {
  try {
    onFinish(details);
  } catch (error) {
    failLoopTransition(loop, cycle.n, error);
  }
}

function spawnLoopSession(loop, cycle, role, prompt, onFinish) {
  const engine = engines.get(loop.engine) || engines.get(store.config.defaultEngine);
  const model = engines.modelFor(engine, store.config, loop.model);
  const cwd = loop.projectPath;
  const outputPath = engine.usesOutputFile
    ? path.join(
      store.paths.results,
      `.${loop.id}.cycle-${cycle.n}.${role}.${Date.now()}.last-message.tmp`,
    )
    : null;
  const args = engine.args({ model, outputPath });
  let child;

  appendLoopLog(loop, `=== cycle ${cycle.n} - ${role} (${engine.label}) ===`);

  try {
    child = spawnEngine(engine, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    finishLoopSession(loop, cycle, onFinish, {
      exitCode: null,
      forceFailed: true,
      reason: `${role}_start_failed`,
      resultText: `${role} failed to start: ${error.message}`,
      timedOut: false,
      cancelled: false,
    });
    return;
  }

  const tail = { text: '', message: '', result: '' };
  let inputFailed = false;
  let timedOut = false;
  let settled = false;
  let timeout;
  const worker = { child, timeout: null, cancelled: false, type: 'loop', role };
  activeWorkers.set(loop.id, worker);
  const captureLine = (line) => {
    appendSessionLog(loop, cycle, role, line);
    trackTail(tail, recordActivity(loop.id, engine, line));
  };
  const finish = (exitCode, signal, forceFailed = false, reason) => {
    if (settled || stopping) {
      return;
    }

    settled = true;
    clearTimeout(timeout);

    if (activeWorkers.get(loop.id) === worker) {
      activeWorkers.delete(loop.id);
    }

    finishLoopSession(loop, cycle, onFinish, {
      exitCode,
      signal,
      forceFailed,
      reason: timedOut ? `${role}_timed_out` : reason || (inputFailed ? `${role}_input_failed` : undefined),
      resultText: finalText(engine, outputPath, tail),
      timedOut,
      cancelled: worker.cancelled,
      ...(typeof tail.costUsd === 'number' ? { costUsd: tail.costUsd } : {}),
    });
  };

  streamLines(child.stdout, captureLine);
  streamLines(child.stderr, captureLine);
  child.once('error', (error) => {
    captureLine(`${role} error: ${error.message}`);
    finish(null, null, true, `${role}_error`);
  });
  child.once('close', (code, signal) => finish(code, signal));
  child.stdin.on('error', (error) => {
    inputFailed = true;
    captureLine(`${role} input error: ${error.message}`);
  });

  const timeoutMin = timeoutMinutes();
  timeout = setTimeout(() => {
    timedOut = true;
    captureLine(`${role} timed out after ${timeoutMin} minutes.`);
    terminateWorker(child);
  }, timeoutMin * 60 * 1000);
  worker.timeout = timeout;

  try {
    child.stdin.end(prompt);
  } catch (error) {
    captureLine(`${role} input error: ${error.message}`);
    finish(null, null, true, `${role}_input_failed`);
  }
}

function startNextLoopCycle(loop) {
  setImmediate(() => {
    const next = readRunningLoop(loop.id);

    if (!next) {
      return;
    }

    if (next.cancelRequested) {
      completeLoop(next, 'cancelled', 'Cancelled.', 'cancelled');
      return;
    }

    startLoopCycle(next);
  });
}

function budgetExhaustedEnd(loop) {
  const done = Array.isArray(loop.done) ? loop.done : [];

  if (!done.length) {
    return { status: 'maxed', summary: 'Reached the maximum cycle count without a passing verdict.' };
  }

  return {
    status: 'incomplete',
    summary: `Completed ${done.length} plan item${done.length === 1 ? '' : 's'} before the cycle budget ran out; work remains.`,
  };
}

function startLoopCycle(loop) {
  if (loop.cancelRequested) {
    completeLoop(loop, 'cancelled', 'Cancelled.', 'cancelled');
    return;
  }

  const cycles = Array.isArray(loop.cycles) ? loop.cycles : [];
  const cycleNumber = cycles.length + 1;
  const polishing = hasPassedCycle(loop);

  if (cycleNumber > loop.maxCycles) {
    const exhausted = budgetExhaustedEnd(loop);

    completeLoop(
      loop,
      polishing ? 'passed' : exhausted.status,
      polishing ? `Passed after ${loop.maxCycles} cycles.` : exhausted.summary,
    );
    return;
  }

  const previous = cycles[cycles.length - 1];
  const startedAt = new Date().toISOString();
  // Plan position at cycle start: completed and blocked items each advanced one slot.
  const taskNumber = (Array.isArray(loop.done) ? loop.done.length : 0)
    + (Array.isArray(loop.blocked) ? loop.blocked.length : 0) + 1;
  const gitAtStart = polishing || loop.noGit ? null : gitSnapshot(loop.projectPath);
  const cycle = {
    n: cycleNumber,
    ...(polishing ? {} : { task: taskNumber }),
    status: 'running',
    phase: polishing ? 'polish' : 'worker',
    startedAt,
    ...(gitAtStart ? { gitAtStart } : {}),
    workerLogId: cycleLogId(loop.id, cycleNumber, 'worker'),
    criticLogId: cycleLogId(loop.id, cycleNumber, 'critic'),
  };
  const runningLoop = {
    ...loop,
    status: 'running',
    cycle: cycleNumber,
    cycles: [...cycles, cycle],
    lastActivity: `Cycle ${cycleNumber} worker starting.`,
  };

  try {
    store.writeTask(runningLoop, 'running');
    recordEvent('cycle_started', { id: loop.id, cycle: cycleNumber });
    runningActivity.set(loop.id, { ts: startedAt, text: runningLoop.lastActivity, toolCalls: 0 });
    spawnLoopSession(
      runningLoop,
      cycle,
      'worker',
      polishing
        ? polishWorkerPrompt(runningLoop, previous && previous.fixes)
        : loopWorkerPrompt(runningLoop, previous && previous.status === 'failed' ? previous.fixes : undefined),
      (details) => finishLoopWorker(runningLoop, cycleNumber, details),
    );
  } catch (error) {
    completeLoop(
      runningLoop,
      polishing ? 'passed' : 'failed',
      polishing ? `Passed before polish cycle ${cycleNumber} could start.` : `Cycle ${cycleNumber} failed to start.`,
      polishing ? undefined : 'cycle_start_failed',
    );
    console.error(`Failed to start cycle ${cycleNumber} for ${loop.id}: ${error.message}`);
  }
}

function finishLoopWorker(loop, cycleNumber, details) {
  const current = readRunningLoop(loop.id);

  if (!current) {
    return;
  }

  try {
    const cycle = currentCycle(current, cycleNumber);

    if (!cycle) {
      if (hasPassedCycle(current)) {
        completeLoop(current, 'passed', `Passed before polish cycle ${cycleNumber} could finish.`);
        return;
      }

      completeLoop(current, 'failed', `Cycle ${cycleNumber} is missing.`, 'cycle_missing');
      return;
    }

    appendSessionResult(loop, cycle, 'worker', details.resultText);
    const finishedAt = new Date().toISOString();
    const durationMs = taskTime(cycle, 'startedAt') ? Math.max(0, Date.now() - taskTime(cycle, 'startedAt')) : 0;

    if (details.cancelled || current.cancelRequested) {
      const cancelled = updateCycle(current, cycleNumber, {
        status: 'cancelled',
        phase: cyclePhase(cycle, 'worker'),
        finishedAt,
        durationMs,
        ...(typeof details.costUsd === 'number' ? { costUsd: details.costUsd } : {}),
      });
      completeLoop(cancelled, 'cancelled', 'Cancelled.', 'cancelled');
      return;
    }

    const parsed = parseLoopResult(details.resultText);
    const reason = workerFailureReason(details, parsed);
    const incompletePolishWorker = cycle.phase === 'polish' && (
      reason === 'timed_out'
      || reason === 'worker_exited_nonzero'
      || reason === 'invalid_loop_result'
      || reason === 'worker_reported_failure'
    );
    const workerFields = {
      workerStatus: reason ? 'failed' : 'done',
      workerSummary: parsed && parsed.summary ? parsed.summary : fallbackSummary(details.resultText, 'failed', details.timedOut),
      workerFinishedAt: finishedAt,
      workerDurationMs: durationMs,
      workerExitCode: details.exitCode,
      ...(typeof details.costUsd === 'number' ? { workerCostUsd: details.costUsd } : {}),
    };

    if (reason) {
      const passed = hasPassedCycle(current);
      const failed = updateCycle(current, cycleNumber, {
        ...workerFields,
        status: 'failed',
        phase: cyclePhase(cycle, 'worker'),
        summary: workerFields.workerSummary,
        finishedAt,
        durationMs,
        reason,
      });
      store.writeTask(failed, 'running');
      recordEvent('worker_finished', { id: loop.id, cycle: cycleNumber, status: 'failed', reason });
      completeLoop(
        failed,
        passed ? 'passed' : 'failed',
        passed && incompletePolishWorker
          ? incompletePolishSummary()
          : passed
            ? `Passed before polish cycle ${cycleNumber} worker could finish.`
            : `Cycle ${cycleNumber} worker failed.`,
        passed ? undefined : reason,
      );
      return;
    }

    // A clean tree is not proof of an idle worker: with autoCommit off, earlier cycles leave work
    // uncommitted, and a worker that commits its own changes leaves the tree clean too.
    if (cycle.phase !== 'polish' && !current.noGit) {
      const idle = madeNoChanges(cycle.gitAtStart, gitSnapshot(current.projectPath));

      if (idle) {
        registerFailedCycle(current, cycleNumber, {
          ...workerFields,
          status: 'failed',
          phase: 'worker',
          verdict: 'FAIL',
          fixes: 'The last cycle changed no files. Make real progress on the next incomplete PLAN.md item.',
          summary: `Cycle ${cycleNumber} worker made no changes.`,
          finishedAt,
          durationMs,
          reason: 'worker made no changes',
        }, {
          type: 'worker_finished',
          data: { id: loop.id, cycle: cycleNumber, status: 'failed', reason: 'worker made no changes' },
        });
        return;
      }
    }

    const awaitingCritic = updateCycle(current, cycleNumber, {
      ...workerFields,
      status: 'running',
      phase: cyclePhase(cycle, 'critic'),
      summary: workerFields.workerSummary || 'Worker finished.',
    });

    try {
      store.writeTask(awaitingCritic, 'running');
      recordEvent('worker_finished', { id: loop.id, cycle: cycleNumber, status: 'done' });
      runningActivity.set(loop.id, {
        ts: finishedAt,
        text: `Cycle ${cycleNumber} critic starting.`,
        toolCalls: 0,
      });
      spawnLoopSession(
        awaitingCritic,
        currentCycle(awaitingCritic, cycleNumber),
        'critic',
        cycle.phase === 'polish'
          ? polishCriticPrompt(details.resultText)
          : criticPrompt(details.resultText, awaitingCritic.blocked),
        (criticDetails) => finishLoopCritic(awaitingCritic, cycleNumber, criticDetails),
      );
    } catch (error) {
      const passed = hasPassedCycle(awaitingCritic);
      const invalid = updateCycle(awaitingCritic, cycleNumber, {
        status: 'critic_invalid',
        phase: cyclePhase(cycle, 'critic'),
        summary: 'Critic failed to start.',
        finishedAt,
        durationMs,
        reason: 'critic_start_failed',
      });
      completeLoop(
        invalid,
        passed ? 'passed' : 'failed',
        passed ? `Passed before polish cycle ${cycleNumber} critic could start.` : `Cycle ${cycleNumber} critic was invalid.`,
        passed ? undefined : 'critic_start_failed',
      );
      console.error(`Failed to start critic for ${loop.id}: ${error.message}`);
    }
  } catch (error) {
    failLoopTransition(current, cycleNumber, error);
  }
}

// Worker and critic run as separate engine sessions; the cycle's spend is their sum.
function cycleCostUsd(cycle, criticCost) {
  const worker = cycle && typeof cycle.workerCostUsd === 'number' ? cycle.workerCostUsd : null;
  const critic = typeof criticCost === 'number' ? criticCost : null;

  if (worker === null && critic === null) {
    return {};
  }

  return { costUsd: state.roundCost((worker || 0) + (critic || 0)) };
}

// done.length counts CONTINUE verdicts only, so it lags the plan once an item is blocked.
function cycleTaskNumber(cycle, fallback) {
  return cycle && Number.isInteger(cycle.task) ? cycle.task : fallback;
}

// The blocked entry names the plan position this cycle was working: done.length alone misses
// earlier blocks, and nextItem still names the item that came before them.
function blockedEntry(loop, cycle) {
  const done = Array.isArray(loop.done) ? loop.done.length : 0;
  const blocked = Array.isArray(loop.blocked) ? loop.blocked.length : 0;
  const task = cycleTaskNumber(cycle, done + blocked + 1);
  const title = (Array.isArray(loop.planTasks) ? loop.planTasks : [])[task - 1];

  return {
    task,
    item: title || (typeof loop.nextItem === 'string' && loop.nextItem ? loop.nextItem : 'first PLAN.md item'),
  };
}

// Shared by critic FAIL verdicts and no-progress cycles: counts the streak,
// blocks the current task at the retry budget, and picks the end state at the cycle cap.
function registerFailedCycle(current, cycleNumber, cycleFields, event) {
  const streak = Math.max(0, Number(current.failStreak) || 0) + 1;
  const blocking = streak >= loopRetries(current.taskRetries);
  const entry = blocking ? blockedEntry(current, currentCycle(current, cycleNumber)) : null;
  const loop = {
    ...current,
    failStreak: entry ? 0 : streak,
    // nextItem named the item worked before this block; a later block must not reuse it.
    ...(entry ? { blocked: [...(Array.isArray(current.blocked) ? current.blocked : []), entry], nextItem: '' } : {}),
  };
  let updated = updateCycle(loop, cycleNumber, entry
    ? { ...cycleFields, status: 'blocked', summary: `Blocked task ${entry.task}: ${entry.item}` }
    : cycleFields);

  if (entry) {
    updated = recordCheckpoint(updated, cycleNumber, `wip(loop): task ${entry.task} blocked - ${entry.item}`);
  }

  store.writeTask(updated, 'running');
  recordEvent(event.type, event.data);

  if (entry) {
    recordEvent('task_blocked', { id: current.id, cycle: cycleNumber, task: entry.task, item: entry.item });
  }

  if (cycleNumber >= updated.maxCycles) {
    const exhausted = budgetExhaustedEnd(updated);

    completeLoop(updated, exhausted.status, exhausted.summary);
    return;
  }

  startNextLoopCycle(updated);
}

function finishLoopCritic(loop, cycleNumber, details) {
  const current = readRunningLoop(loop.id);

  if (!current) {
    return;
  }

  try {
    const cycle = currentCycle(current, cycleNumber);

    if (!cycle) {
      if (hasPassedCycle(current)) {
        completeLoop(current, 'passed', `Passed before polish cycle ${cycleNumber} could finish.`);
        return;
      }

      completeLoop(current, 'failed', `Cycle ${cycleNumber} is missing.`, 'cycle_missing');
      return;
    }

    appendSessionResult(loop, cycle, 'critic', details.resultText);
    const finishedAt = new Date().toISOString();
    const durationMs = taskTime(cycle, 'startedAt') ? Math.max(0, Date.now() - taskTime(cycle, 'startedAt')) : 0;

    if (details.cancelled || current.cancelRequested) {
      const cancelled = updateCycle(current, cycleNumber, {
        status: 'cancelled',
        phase: cyclePhase(cycle, 'critic'),
        finishedAt,
        durationMs,
        ...cycleCostUsd(cycle, details.costUsd),
      });
      completeLoop(cancelled, 'cancelled', 'Cancelled.', 'cancelled');
      return;
    }

    const polishing = cycle.phase === 'polish';
    const verdict = polishing
      ? parsePolishVerdict(details.resultText)
      : parseCriticVerdict(details.resultText);
    const reason = criticFailureReason(details, verdict);
    const incompletePolishCritic = polishing && Boolean(reason);

    if (reason) {
      const passed = hasPassedCycle(current);
      const invalid = updateCycle(current, cycleNumber, {
        status: 'critic_invalid',
        phase: cyclePhase(cycle, 'critic'),
        summary: 'Critic did not produce a valid verdict.',
        finishedAt,
        durationMs,
        reason,
        ...cycleCostUsd(cycle, details.costUsd),
      });
      store.writeTask(invalid, 'running');
      recordEvent('critic_invalid', { id: loop.id, cycle: cycleNumber, reason });
      completeLoop(
        invalid,
        passed ? 'passed' : 'failed',
        passed && incompletePolishCritic
          ? incompletePolishSummary()
          : passed
            ? `Passed before polish cycle ${cycleNumber} received a valid verdict.`
            : `Cycle ${cycleNumber} critic was invalid.`,
        passed ? undefined : reason,
      );
      return;
    }

    if (polishing) {
      if (verdict.verdict === 'SHIP') {
        let shipped = updateCycle(current, cycleNumber, {
          status: 'passed',
          phase: 'polish',
          verdict: 'SHIP',
          summary: cycle.workerSummary || 'Critic shipped.',
          finishedAt,
          durationMs,
          ...cycleCostUsd(cycle, details.costUsd),
        });
        // Without this the shipped tree stays dirty and the next auto-checkpoint loop is refused.
        shipped = recordCheckpoint(shipped, null, 'wip(loop): polish shipped');
        store.writeTask(shipped, 'running');
        recordEvent('critic_verdict', { id: loop.id, cycle: cycleNumber, verdict: 'SHIP' });
        completeLoop(shipped, 'passed', `Shipped on cycle ${cycleNumber}.`);
        return;
      }

      const improved = updateCycle(current, cycleNumber, {
        status: 'improve',
        phase: 'polish',
        verdict: 'IMPROVE',
        fixes: verdict.improvement,
        summary: `Polish improvement: ${verdict.improvement}`,
        finishedAt,
        durationMs,
        ...cycleCostUsd(cycle, details.costUsd),
      });
      store.writeTask(improved, 'running');
      recordEvent('critic_verdict', {
        id: loop.id,
        cycle: cycleNumber,
        verdict: 'IMPROVE',
        fixes: verdict.improvement,
      });

      if (cycleNumber >= current.maxCycles) {
        completeLoop(
          improved,
          'passed',
          'The final improvement was not applied; the working tree may not match the last validated state.',
        );
        return;
      }

      startNextLoopCycle(improved);
      return;
    }

    if (verdict.verdict === 'PASS') {
      const blockedCount = Array.isArray(current.blocked) ? current.blocked.length : 0;
      let passed = updateCycle(current, cycleNumber, {
        status: 'passed',
        phase: 'critic',
        verdict: 'PASS',
        summary: cycle.workerSummary || 'Critic passed.',
        finishedAt,
        durationMs,
        ...cycleCostUsd(cycle, details.costUsd),
      });
      passed = recordCheckpoint(passed, null, 'wip(loop): final pass');
      store.writeTask(passed, 'running');
      recordEvent('critic_verdict', { id: loop.id, cycle: cycleNumber, verdict: 'PASS' });

      if (blockedCount) {
        completeLoop(passed, 'partial', `Passed with ${blockedCount} blocked task${blockedCount === 1 ? '' : 's'}.`);
        return;
      }

      if (current.polish === true && cycleNumber < current.maxCycles) {
        startNextLoopCycle(passed);
        return;
      }

      completeLoop(passed, 'passed', `Passed on cycle ${cycleNumber}.`);
      return;
    }

    if (verdict.verdict === 'CONTINUE') {
      const done = [...(Array.isArray(current.done) ? current.done : []), verdict.done];
      const task = cycleTaskNumber(cycle, done.length);
      let continued = updateCycle(
        { ...current, done, nextItem: verdict.next, failStreak: 0 },
        cycleNumber,
        {
          status: 'continue',
          phase: 'critic',
          verdict: 'CONTINUE',
          done: verdict.done,
          next: verdict.next,
          summary: `Task ${task} done: ${verdict.done}`,
          finishedAt,
          durationMs,
          ...cycleCostUsd(cycle, details.costUsd),
        },
      );
      continued = recordCheckpoint(continued, cycleNumber, `wip(loop): task ${task} - ${verdict.done}`);
      store.writeTask(continued, 'running');
      recordEvent('critic_verdict', {
        id: loop.id,
        cycle: cycleNumber,
        verdict: 'CONTINUE',
        done: verdict.done,
        next: verdict.next,
      });

      if (cycleNumber >= current.maxCycles) {
        const exhausted = budgetExhaustedEnd(continued);

        completeLoop(continued, exhausted.status, exhausted.summary);
        return;
      }

      startNextLoopCycle(continued);
      return;
    }

    registerFailedCycle(current, cycleNumber, {
      status: 'failed',
      phase: 'critic',
      verdict: 'FAIL',
      fixes: verdict.fixes,
      summary: `Critic failed: ${verdict.fixes}`,
      finishedAt,
      durationMs,
      ...cycleCostUsd(cycle, details.costUsd),
    }, {
      type: 'critic_verdict',
      data: { id: loop.id, cycle: cycleNumber, verdict: 'FAIL', fixes: verdict.fixes },
    });
  } catch (error) {
    failLoopTransition(current, cycleNumber, error);
  }
}

function startLoop(loop) {
  const startedAt = new Date().toISOString();
  let planTasks = [];

  try {
    planTasks = parsePlanTasks(fs.readFileSync(path.join(loop.projectPath, 'PLAN.md'), 'utf8'));
  } catch {
  }

  const runningLoop = {
    ...loop,
    status: 'running',
    startedAt,
    cycle: 0,
    cycles: Array.isArray(loop.cycles) ? loop.cycles : [],
    ...(planTasks.length ? { planTasks } : {}),
  };

  try {
    store.moveTask(loop.id, 'pending', 'running');
  } catch (error) {
    console.error(`Failed to start ${loop.id}: ${error.message}`);
    return;
  }

  // The enqueue gate approved a tree that can drift while the loop waits for a slot.
  // A loop queued before the snapshot existed has no baseline to compare, so it is left alone.
  if (loop.gitAtQueue && !madeNoChanges(loop.gitAtQueue, gitSnapshot(loop.projectPath))) {
    completeLoop(runningLoop, 'failed', dirtyTreeError, 'dirty_project_tree');
    return;
  }

  try {
    store.writeTask(runningLoop, 'running');
    recordEvent('loop_started', { id: loop.id });
    runningActivity.set(loop.id, { ts: startedAt, text: 'Loop starting.', toolCalls: 0 });
    startLoopCycle(runningLoop);
  } catch (error) {
    completeLoop(runningLoop, 'failed', 'Loop failed to start.', 'loop_start_failed');
    console.error(`Failed to start ${loop.id}: ${error.message}`);
  }
}

function spawnWorker(task) {
  const engine = engines.get(task.engine) || engines.get(store.config.defaultEngine);
  const model = engines.modelFor(engine, store.config, task.model);
  const cwd = task.cwd ? path.resolve(task.cwd) : path.join(store.paths.root, 'workspace');
  const outputPath = engine.usesOutputFile
    ? path.join(store.paths.results, `.${task.id}.${Date.now()}.last-message.tmp`)
    : null;
  const args = engine.args({ model, outputPath });
  let child;

  try {
    fs.mkdirSync(cwd, { recursive: true });
    child = spawnEngine(engine, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    completeTask(task, {
      exitCode: null,
      forceFailed: true,
      reason: 'worker_start_failed',
      resultText: `Worker failed to start: ${error.message}`,
      timedOut: false,
    });
    return;
  }

  const tail = { text: '', message: '', result: '' };
  let inputFailed = false;
  let timedOut = false;
  let settled = false;
  let timeout;
  const worker = { child, timeout: null, cancelled: false };
  activeWorkers.set(task.id, worker);
  const captureLine = (line) => {
    try {
      store.appendLogLine(task.id, line);
    } catch (error) {
      console.error(`Failed to write log for ${task.id}: ${error.message}`);
    }

    trackTail(tail, recordActivity(task.id, engine, line));
  };
  const finish = (exitCode, signal, forceFailed = false, reason) => {
    if (settled || stopping) {
      return;
    }

    settled = true;
    clearTimeout(timeout);
    activeWorkers.delete(task.id);
    completeTask(task, {
      exitCode,
      signal,
      forceFailed,
      reason: timedOut ? 'timed_out' : reason || (inputFailed ? 'worker_input_failed' : undefined),
      resultText: finalText(engine, outputPath, tail),
      timedOut,
      cancelled: worker.cancelled,
      ...(typeof tail.costUsd === 'number' ? { costUsd: tail.costUsd } : {}),
    });
  };

  streamLines(child.stdout, captureLine);
  streamLines(child.stderr, captureLine);
  child.once('error', (error) => {
    captureLine(`Worker error: ${error.message}`);
    finish(null, null, true, 'worker_error');
  });
  child.once('close', (code, signal) => finish(code, signal));
  child.stdin.on('error', (error) => {
    inputFailed = true;
    captureLine(`Worker input error: ${error.message}`);
  });

  const timeoutMin = timeoutMinutes();
  timeout = setTimeout(() => {
    timedOut = true;
    captureLine(`Worker timed out after ${timeoutMin} minutes.`);
    terminateWorker(child);
  }, timeoutMin * 60 * 1000);
  worker.timeout = timeout;

  try {
    child.stdin.end(taskPrompt(task));
  } catch (error) {
    captureLine(`Worker input error: ${error.message}`);
    finish(null, null, true, 'worker_input_failed');
  }
}

function startTask(task) {
  const runningTask = {
    ...task,
    startedAt: new Date().toISOString(),
  };

  try {
    store.moveTask(task.id, 'pending', 'running');
  } catch (error) {
    console.error(`Failed to start ${task.id}: ${error.message}`);
    return;
  }

  try {
    store.writeTask(runningTask, 'running');
    recordEvent('start', { id: task.id });
    runningActivity.set(task.id, {
      ts: runningTask.startedAt,
      text: 'Worker starting.',
      toolCalls: 0,
    });
    spawnWorker(runningTask);
  } catch (error) {
    completeTask(runningTask, {
      exitCode: null,
      forceFailed: true,
      reason: 'worker_start_failed',
      resultText: `Worker failed to start: ${error.message}`,
      timedOut: false,
    });
  }
}

function fillSlots() {
  const maxConcurrent = Math.max(1, Number(store.config.maxConcurrent) || 2);
  const runningCount = store.listTasks('running').length;
  const slots = Math.max(0, maxConcurrent - runningCount);

  if (!slots) {
    return;
  }

  const pending = sortPending(store.listTasks('pending'));

  for (const task of pending.slice(0, slots)) {
    if (task.type === 'loop') {
      startLoop(task);
    } else {
      startTask(task);
    }
  }
}

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, { 'content-type': contentType });
  res.end(body);
}

function sendJson(res, statusCode, value) {
  send(res, statusCode, JSON.stringify(value), 'application/json; charset=utf-8');
}

function resultForTask(task) {
  try {
    const resultPath = path.join(store.paths.results, `${task.id}.json`);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    return result && typeof result === 'object' ? result : null;
  } catch {
    return null;
  }
}

function dashboardEvent(event) {
  const id = typeof event.id === 'string' ? event.id : '';
  const task = id ? `task ${id}` : 'task';
  const loop = id ? `loop ${id}` : 'loop';
  const cycle = Number.isInteger(event.cycle) ? ` cycle ${event.cycle}` : '';
  const reason = typeof event.reason === 'string' ? `: ${event.reason}` : '';
  const value = {
    ts: typeof event.ts === 'string' ? event.ts : '',
    kind: 'info',
    text: 'activity',
    ...(id ? { taskId: id } : {}),
  };

  if (event.type === 'loop_started') {
    return { ...value, kind: 'spawn', text: `${loop} started` };
  }

  if (event.type === 'loop_queued') {
    return { ...value, kind: 'queue', text: `${loop} queued` };
  }

  if (event.type === 'cycle_started') {
    return { ...value, kind: 'spawn', text: `${loop}${cycle} started` };
  }

  if (event.type === 'worker_finished') {
    const status = event.status === 'done' ? 'finished' : 'failed';
    return { ...value, kind: event.status === 'done' ? 'result' : 'error', text: `${loop}${cycle} worker ${status}${reason}` };
  }

  if (event.type === 'critic_verdict') {
    const verdict = ['PASS', 'FAIL', 'IMPROVE', 'SHIP', 'CONTINUE'].includes(event.verdict) ? event.verdict : 'FAIL';
    const detail = ['FAIL', 'IMPROVE'].includes(verdict) && typeof event.fixes === 'string'
      ? `: ${event.fixes}`
      : verdict === 'CONTINUE' && typeof event.done === 'string' ? `: done: ${event.done}` : '';
    const kind = ['PASS', 'SHIP', 'CONTINUE'].includes(verdict) ? 'result' : verdict === 'IMPROVE' ? 'info' : 'error';
    return { ...value, kind, text: `${loop}${cycle} critic ${verdict}${detail}` };
  }

  if (event.type === 'task_blocked') {
    const item = typeof event.item === 'string' ? `: ${event.item}` : '';
    const taskNumber = Number.isInteger(event.task) ? ` task ${event.task}` : '';
    return { ...value, kind: 'error', text: `${loop}${taskNumber} blocked${item}` };
  }

  if (event.type === 'critic_invalid') {
    return { ...value, kind: 'error', text: `${loop}${cycle} critic invalid${reason}` };
  }

  if (event.type === 'loop_ended') {
    const status = typeof event.status === 'string' ? event.status : 'finished';
    const kind = status === 'passed' ? 'result' : status === 'failed' ? 'error' : 'info';
    return { ...value, kind, text: `${loop} ended: ${status}${reason}` };
  }

  if (event.type === 'queue') {
    return { ...value, kind: 'queue', text: `queued ${task}` };
  }

  if (event.type === 'start') {
    return { ...value, kind: 'spawn', text: `${task} started` };
  }

  if (event.type === 'done') {
    return { ...value, kind: 'result', text: `${task} done` };
  }

  if (event.type === 'fail') {
    return { ...value, kind: 'error', text: `${task} failed${reason}` };
  }

  if (event.type === 'cancel') {
    return { ...value, kind: 'info', text: `${task} cancelled${reason}` };
  }

  return { ...value, text: typeof event.type === 'string' ? event.type : value.text };
}

function recentEvents() {
  try {
    const size = fs.statSync(store.paths.events).size;

    if (!size) {
      return [];
    }

    const length = Math.min(size, maxEventBytes);
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(store.paths.events, 'r');
    let bytesRead;

    try {
      bytesRead = fs.readSync(descriptor, buffer, 0, length, size - length);
    } finally {
      fs.closeSync(descriptor);
    }

    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);

    if (size > length) {
      lines.shift();
    }

    if (lines[lines.length - 1] === '') {
      lines.pop();
    }

    const events = [];

    for (const line of lines.reverse()) {
      try {
        const event = JSON.parse(line);

        if (event && typeof event === 'object' && !Array.isArray(event)) {
          events.push(dashboardEvent(event));
          if (events.length === 30) {
            break;
          }
        }
      } catch {
      }
    }

    return events;
  } catch {
    return [];
  }
}

function daemonState() {
  const now = Date.now();
  const defaultEngine = store.config.defaultEngine;
  const pendingTasks = sortPending(store.listTasks('pending'));
  const runningTasks = store.listTasks('running');
  const completedTasks = store.listTasks('done');
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const done = completedTasks.filter((task) => (
    task.status === 'done' || (task.type === 'loop' && task.status === 'passed')
  )).length;
  const failed = completedTasks.filter((task) => (
    task.status === 'failed' || (task.type === 'loop' && task.status === 'maxed')
  )).length;
  const finishedToday = completedTasks.filter((task) => taskTime(task, 'finishedAt') >= todayMs).length;
  const results = new Map();
  const resultFor = (task) => {
    if (!results.has(task.id)) {
      results.set(task.id, resultForTask(task));
    }

    return results.get(task.id);
  };
  const taskCostToday = (task) => {
    if (task.type === 'loop') {
      return state.sumCycleCosts(task.cycles, todayMs);
    }

    if (taskTime(task, 'finishedAt') < todayMs) {
      return null;
    }

    const result = resultFor(task);

    return result && typeof result.costUsd === 'number' && Number.isFinite(result.costUsd)
      ? result.costUsd
      : null;
  };
  let todayCost = null;

  for (const task of [...runningTasks, ...completedTasks]) {
    const cost = taskCostToday(task);

    if (cost !== null) {
      todayCost = (todayCost || 0) + cost;
    }
  }

  return {
    daemon: {
      alive: true,
      pid: daemonInfo.pid,
      port: daemonInfo.port,
      startedAt: daemonInfo.startedAt,
      ts: new Date().toISOString(),
      engine: defaultEngine,
    },
    bridge: {
      running: bridgeRunning(),
    },
    engines: {
      selected: defaultEngine,
      available: engines.ids().map((id) => {
        const engine = engines.get(id);

        return {
          id,
          label: engine.label,
          installed: engines.available(engine, store.config.enginePaths),
        };
      }),
    },
    stats: {
      pending: pendingTasks.length,
      running: runningTasks.length,
      done,
      failed,
      today: {
        tasks: finishedToday,
        ...(todayCost !== null ? { costUsd: state.roundCost(todayCost) } : {}),
      },
      totalDone: done,
    },
    tasks: {
      pending: pendingTasks.map((task) => state.publicPending(task, defaultEngine)),
      running: runningTasks.map((task) => state.publicRunning(task, runningActivity.get(task.id), defaultEngine, now)),
      blocked: [],
      recent: completedTasks
        .sort((left, right) => taskTime(right, 'finishedAt') - taskTime(left, 'finishedAt'))
        .slice(0, 20)
        .map((task) => state.publicRecent(task, resultFor(task), defaultEngine)),
    },
    messages: store.readMessages(50),
    events: recentEvents(),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);

      if (size > 1000000) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }

      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function serveDashboard(res) {
  const dashboardPath = path.join(store.paths.root, 'public', 'index.html');

  try {
    send(res, 200, fs.readFileSync(dashboardPath), 'text/html; charset=utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      send(res, 404, 'Not found.', 'text/plain; charset=utf-8');
      return;
    }

    throw error;
  }
}

function taskSource(body) {
  return body && body.source === 'mcp' ? 'mcp' : 'api';
}

async function dispatch(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    sendJson(res, 400, { error: 'prompt is required.' });
    return;
  }

  const engine = body.engine || store.config.defaultEngine;

  if (!knownEngines.has(engine)) {
    sendJson(res, 400, { error: `Unsupported engine: ${engine}.` });
    return;
  }

  const task = store.enqueueTask({
    prompt: body.prompt,
    engine,
    model: body.model,
    cwd: body.cwd,
    title: body.title,
    priority: body.priority,
    source: taskSource(body),
  });
  recordEvent('queue', { id: task.id });

  sendJson(res, 201, { id: task.id });
}

async function createMessage(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const text = body && typeof body.text === 'string' ? body.text.trim() : '';

  if (!text) {
    sendJson(res, 400, { error: 'text is required.' });
    return;
  }

  if (Array.from(text).length > 2000) {
    sendJson(res, 400, { error: 'text must be 2000 characters or fewer.' });
    return;
  }

  const kind = body && typeof body === 'object' && body.kind !== undefined ? body.kind : 'info';

  if (!messageKinds.has(kind)) {
    sendJson(res, 400, { error: 'kind must be info, question, or results.' });
    return;
  }

  sendJson(res, 200, store.appendMessage({ kind, text }));
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function loopProjectPath(project) {
  return path.isAbsolute(project)
    ? path.resolve(project)
    : path.resolve(store.paths.root, project);
}

function hasActiveLoop(projectPath) {
  for (const stage of ['pending', 'running']) {
    for (const task of store.listTasks(stage)) {
      if (task.type !== 'loop' || terminalTaskStatuses.has(task.status) || typeof task.projectPath !== 'string') {
        continue;
      }

      try {
        if (fs.realpathSync(task.projectPath) === projectPath) {
          return true;
        }
      } catch {
      }
    }
  }

  return false;
}

function runGit(projectPath, args) {
  try {
    const result = spawnSync('git', args, {
      cwd: projectPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });

    if (result.error || result.status !== 0) {
      const output = String(result.stderr || result.stdout || (result.error && result.error.message) || '').trim();
      return { ok: false, output };
    }

    return { ok: true, output: String(result.stdout || '').trim() };
  } catch (error) {
    return { ok: false, output: error.message };
  }
}

// Porcelain records status codes and paths, never content: with autoCommit off a worker can rewrite
// the same already-dirty files every cycle and leave an identical status.
function dirtyDigest(projectPath) {
  const listed = runGit(projectPath, ['ls-files', '-m', '-o', '--exclude-standard', '-z', '--', '.']);

  if (!listed.ok) {
    return null;
  }

  const digest = crypto.createHash('sha1');

  for (const file of listed.output.split('\0').filter(Boolean).sort()) {
    const filePath = path.join(projectPath, file);
    digest.update(file);

    try {
      const stats = fs.statSync(filePath);

      digest.update(stats.size > maxDigestBytes ? `${stats.size}:${stats.mtimeMs}` : fs.readFileSync(filePath));
    } catch {
      digest.update('\0gone');
    }
  }

  return digest.digest('hex');
}

// A checkpoint commit and a worker's own commit both move HEAD, so progress is the triple
// (HEAD, tree, content) changing - not the tree simply being dirty.
function gitSnapshot(projectPath) {
  const tree = runGit(projectPath, ['status', '--porcelain', '--', '.']);
  const dirty = tree.ok ? dirtyDigest(projectPath) : null;

  if (!tree.ok || dirty === null) {
    return null;
  }

  const head = runGit(projectPath, ['rev-parse', 'HEAD']);

  return { head: head.ok ? head.output : '', tree: tree.output, dirty };
}

function madeNoChanges(before, after) {
  return Boolean(before) && Boolean(after)
    && before.head === after.head && before.tree === after.tree && before.dirty === after.dirty;
}

function insideGitWorkTree(projectPath) {
  const result = runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  return result.ok && result.output === 'true';
}

// A worker that committed its own work leaves nothing to commit, so its sha is this cycle's
// checkpoint. HEAD advancing over a clean tree is what separates that from a real git failure.
function workerCommitSha(headAtStart, head, tree) {
  return headAtStart && head && head !== headAtStart && tree === '' ? head : null;
}

// Checkpoint messages are daemon-authored from verdict text alone; agents never run git.
function checkpointCommit(loop, message, headAtStart) {
  if (loop.autoCommit !== true) {
    return null;
  }

  const value = String(message).replace(/\s+/g, ' ').trim().slice(0, 72);
  const add = runGit(loop.projectPath, ['add', '-A', '.']);
  const commit = add.ok ? runGit(loop.projectPath, ['commit', '-m', value, '--', '.']) : add;
  const head = runGit(loop.projectPath, ['rev-parse', 'HEAD']);

  if (!commit.ok) {
    const tree = runGit(loop.projectPath, ['status', '--porcelain', '--', '.']);
    const adopted = head.ok && tree.ok ? workerCommitSha(headAtStart, head.output, tree.output) : null;

    if (!adopted) {
      appendLoopLog(loop, `checkpoint failed: ${commit.output || 'git error'}`);
    }

    return adopted;
  }

  return head.ok && head.output ? head.output : null;
}

// cycleNumber ties the sha to that cycle's plan position; null marks the final-pass checkpoint.
function recordCheckpoint(loop, cycleNumber, message) {
  const cycle = cycleNumber === null ? null : currentCycle(loop, cycleNumber);
  const sha = checkpointCommit(loop, message, cycle && cycle.gitAtStart ? cycle.gitAtStart.head : '');

  if (!sha) {
    return loop;
  }

  const task = cycleTaskNumber(cycle, null);

  return {
    ...loop,
    checkpointShas: [
      ...(Array.isArray(loop.checkpointShas) ? loop.checkpointShas : []),
      { ...(task === null ? {} : { task }), sha },
    ],
  };
}

function seedLoopFiles(projectPath) {
  const defaults = [
    [
      path.join(projectPath, 'STATE.md'),
      '# State\n\n## Completed\n\n- Nothing yet.\n\n## Next\n\n- Start with the first incomplete plan item.\n\n## Notes\n\n- None.\n',
    ],
    [
      path.join(projectPath, 'GUIDELINES.md'),
      '# Quality Guidelines\n\n- Meet every requirement in PLAN.md.\n- Keep changes scoped to this project.\n- Validate inputs and relevant edge cases.\n- Add concise usage guidance for runnable work.\n- Run an appropriate check before finishing.\n',
    ],
  ];

  for (const [filePath, content] of defaults) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }
}

async function createLoop(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const project = body && typeof body.project === 'string' ? body.project.trim() : '';

  if (!project) {
    sendJson(res, 400, { error: 'project is required.' });
    return;
  }

  const requestedProjectPath = loopProjectPath(project);

  if (!isDirectory(requestedProjectPath)) {
    sendJson(res, 400, { error: 'Project folder does not exist.' });
    return;
  }

  let rootPath;
  let projectPath;

  try {
    rootPath = fs.realpathSync(store.paths.root);
    projectPath = fs.realpathSync(requestedProjectPath);
  } catch {
    sendJson(res, 400, { error: 'Project folder does not exist.' });
    return;
  }

  const relative = path.relative(rootPath, projectPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendJson(res, 400, { error: 'Project folder must be inside the AgentLoop root.' });
    return;
  }

  if (!isFile(path.join(projectPath, 'PLAN.md'))) {
    sendJson(res, 400, { error: 'Project folder must contain PLAN.md.' });
    return;
  }

  if (hasActiveLoop(projectPath)) {
    sendJson(res, 400, { error: 'A loop is already running for this project.' });
    return;
  }

  const engine = body && typeof body.engine === 'string' && body.engine.trim()
    ? body.engine.trim()
    : store.config.defaultEngine;
  const polish = body && body.polish === true;

  if (!knownEngines.has(engine)) {
    sendJson(res, 400, { error: `Unsupported engine: ${engine}.` });
    return;
  }

  const gitPresent = insideGitWorkTree(projectPath);
  const autoCommit = !(body && body.autoCommit === false) && gitPresent;

  // Must run before seedLoopFiles: seeded STATE.md and GUIDELINES.md would trip it.
  if (autoCommit) {
    const status = runGit(projectPath, ['status', '--porcelain', '--', '.']);

    if (!status.ok || status.output) {
      sendJson(res, 400, { error: dirtyTreeError });
      return;
    }
  }

  try {
    seedLoopFiles(projectPath);
  } catch (error) {
    sendJson(res, 500, { error: `Could not seed loop files: ${error.message}` });
    return;
  }

  // The tree this gate approved, seeded files included: a queued loop revalidates against it.
  const gitAtQueue = autoCommit ? gitSnapshot(projectPath) : null;
  const loop = store.enqueueLoop({
    project,
    projectPath,
    maxCycles: loopCycles(body && body.maxCycles),
    taskRetries: loopRetries(body && body.taskRetries),
    autoCommit,
    ...(gitAtQueue ? { gitAtQueue } : {}),
    ...(gitPresent ? {} : { noGit: true }),
    ...(polish ? { polish: true } : {}),
    engine,
    title: `loop: ${project}`,
    source: taskSource(body),
  });
  recordEvent('loop_queued', { id: loop.id });
  sendJson(res, 201, { id: loop.id });
}

function logLineCount(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return 200;
  }

  return Math.min(maxLogLines, parsed);
}

function logTaskId(requestPath) {
  try {
    const decoded = decodeURIComponent(requestPath);
    const cycle = /^\/api\/log\/([A-Za-z0-9_-]+)\/cycle\/([1-9][0-9]*)\/(worker|critic)$/.exec(decoded);

    if (cycle) {
      return cycleLogId(cycle[1], Number(cycle[2]), cycle[3]);
    }

    return decoded.slice('/api/log/'.length);
  } catch {
    return '';
  }
}

function serveLog(res, requestPath, requestUrl) {
  const id = logTaskId(requestPath);

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    sendJson(res, 200, { lines: [] });
    return;
  }

  sendJson(res, 200, { lines: store.readLogLines(id, logLineCount(requestUrl.searchParams.get('lines'))) });
}

async function cancelTask(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const id = body && typeof body.id === 'string' ? body.id : '';

  if (!id) {
    sendJson(res, 400, { error: 'id is required.' });
    return;
  }

  const worker = activeWorkers.get(id);

  if (!worker) {
    const loop = readRunningLoop(id);

    if (loop) {
      const cycle = currentCycle(loop, loop.cycle);
      const cancelled = cycle && cycle.status === 'running'
        ? updateCycle(loop, loop.cycle, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
        })
        : loop;
      completeLoop(cancelled, 'cancelled', 'Cancelled.', 'cancelled');
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'Task is not running.' });
    return;
  }

  if (worker.cancelled) {
    sendJson(res, 409, { error: 'Task is already being cancelled.' });
    return;
  }

  let loop;

  if (worker.type === 'loop') {
    loop = readRunningLoop(id);

    if (loop) {
      try {
        store.writeTask({ ...loop, cancelRequested: true, lastActivity: 'Cancellation requested.' }, 'running');
      } catch (error) {
        console.error(`Failed to mark ${id} as cancelled: ${error.message}`);
      }
    }
  }

  worker.cancelled = true;
  clearTimeout(worker.timeout);
  worker.timeout = null;
  terminateWorker(worker.child);

  if (loop) {
    const cycle = currentCycle(loop, loop.cycle);
    const cancelled = cycle && cycle.status === 'running'
      ? updateCycle(loop, loop.cycle, {
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
      })
      : loop;
    completeLoop(cancelled, 'cancelled', 'Cancelled.', 'cancelled');
  }

  sendJson(res, 200, { ok: true });
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const requestPath = requestUrl.pathname;

  if (req.method === 'GET' && (requestPath === '/' || requestPath === '/index.html')) {
    serveDashboard(res);
    return;
  }

  if (req.method === 'GET' && requestPath === '/api/state') {
    sendJson(res, 200, state.sanitizeState(daemonState()));
    return;
  }

  if (req.method === 'GET' && requestPath === '/api/bridge') {
    sendJson(res, 200, await bridgeDetails());
    return;
  }

  if (req.method === 'GET' && requestPath.startsWith('/api/log/')) {
    serveLog(res, requestPath, requestUrl);
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/dispatch') {
    await dispatch(req, res);
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/loop') {
    await createLoop(req, res);
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/bridge/start') {
    sendJson(res, 200, { running: startBridge() || bridgeRunning() });
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/bridge/stop') {
    stopBridge();
    sendJson(res, 200, { running: bridgeRunning() });
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/cancel') {
    await cancelTask(req, res);
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/message') {
    await createMessage(req, res);
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/answer') {
    sendJson(res, 400, { error: 'not enabled' });
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
}

function tick() {
  try {
    store.writeHeartbeat(daemonInfo);
    fillSlots();
  } catch (error) {
    console.error(`Daemon tick failed: ${error.message}`);
  }
}

function recoverRunningTasks() {
  for (const task of store.listTasks('running')) {
    if (terminalTaskStatuses.has(task.status)) {
      try {
        store.moveTask(task.id, 'running', 'done');
      } catch (error) {
        console.error(`Failed to recover ${task.id}: ${error.message}`);
      }
      continue;
    }

    const finishedAt = new Date().toISOString();
    const isLoop = task.type === 'loop';
    const passed = isLoop && hasPassedCycle(task);
    const interruptedPolishCycle = isLoop && (Array.isArray(task.cycles) ? task.cycles : []).some((cycle) => (
      cycle && cycle.status === 'running' && cycle.phase === 'polish'
    ));
    const cycles = (Array.isArray(task.cycles) ? task.cycles : []).map((cycle) => (
      cycle && cycle.status === 'running'
        ? {
          ...cycle,
          status: 'failed',
          summary: 'Daemon restarted before the cycle finished.',
          finishedAt,
          reason: 'daemon_restarted',
        }
        : cycle
    ));
    const summary = passed
      ? interruptedPolishCycle
        ? incompletePolishSummary()
        : 'Passed before the daemon restarted.'
      : isLoop
        ? 'Daemon restarted before the loop finished.'
        : 'Daemon restarted before the task finished.';
    const recovered = {
      ...task,
      ...(isLoop ? { cycles } : {}),
      status: passed ? 'passed' : 'failed',
      summary,
      finishedAt,
      ...(passed ? {} : { reason: 'daemon_restarted' }),
    };
    const result = {
      id: task.id,
      status: passed ? 'passed' : 'failed',
      summary,
      ...(passed ? {} : { reason: 'daemon_restarted' }),
      durationMs: taskTime(task, 'startedAt') ? Math.max(0, Date.now() - taskTime(task, 'startedAt')) : 0,
      finishedAt,
    };

    try {
      store.writeResult(result);
      store.writeTask(recovered, 'running');
      store.moveTask(task.id, 'running', 'done');
      recordEvent(isLoop ? 'loop_ended' : 'fail', {
        id: task.id,
        ...(isLoop ? { status: passed ? 'passed' : 'failed' } : {}),
        ...(passed ? {} : { reason: 'daemon_restarted' }),
      });
    } catch (error) {
      console.error(`Failed to recover ${task.id}: ${error.message}`);
    }
  }
}

function stop() {
  stopping = true;
  stopBridge();
  const workers = [...activeWorkers.values()];

  for (const worker of workers) {
    clearTimeout(worker.timeout);
  }

  for (const worker of workers) {
    stopWorker(worker.child);
  }

  activeWorkers.clear();
  clearInterval(ticker);

  if (server) {
    server.close();
  }
}

function start() {
  store.ensureDirs();

  daemonInfo = {
    pid: process.pid,
    port: store.config.dashboardPort,
    startedAt: new Date().toISOString(),
  };

  if (!store.acquireHeartbeat(daemonInfo)) {
    console.log('AgentLoop daemon is already running.');
    return;
  }

  recoverBridgeHeartbeat();
  recoverRunningTasks();

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { error: error.message });
    });
  });
  server.on('error', (error) => {
    console.error(`HTTP server failed: ${error.message}`);
    process.exitCode = 1;
    stop();
  });
  server.listen(daemonInfo.port, '127.0.0.1', () => {
    if (stopping) {
      return;
    }

    console.log(`Dashboard: http://127.0.0.1:${daemonInfo.port}`);
    ticker = setInterval(tick, pollMs);
    tick();
  });

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  start();
}

module.exports = {
  start,
  fillSlots,
  blockedEntry,
  cycleTaskNumber,
  gitSnapshot,
  madeNoChanges,
  workerCommitSha,
};
