// Daemon scheduler, worker runner, and local HTTP API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const store = require('./store');
const { taskPrompt, parseLoopResult } = require('./prompts');

const pollMs = 1500;
const maxResultText = 20000;
const maxLogLines = 1000;
const maxEventBytes = 16 * 1024;
const runningActivity = new Map();
const activeWorkers = new Map();

let daemonInfo;
let server;
let ticker;
let stopping = false;

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

function workerEvent(line) {
  try {
    const event = JSON.parse(line);
    return event && typeof event === 'object' ? event : null;
  } catch {
    return null;
  }
}

function eventText(line, event = workerEvent(line)) {
  if (!event) {
    return line;
  }

  const item = event.item && typeof event.item === 'object' ? event.item : {};
  const candidates = [
    event.text,
    event.message,
    event.content,
    item.text,
    item.command,
    item.aggregated_output,
    item.output,
    item.content,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      return candidate;
    }
  }

  return typeof event.type === 'string' ? event.type : line;
}

function isToolEvent(event) {
  const item = event && event.item;

  return event && event.type === 'item.completed' && item && [
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'web_search',
  ].includes(item.type);
}

function recordActivity(id, line) {
  const event = workerEvent(line);
  const text = eventText(line, event).trim();

  if (!text) {
    return '';
  }

  const previous = runningActivity.get(id);
  runningActivity.set(id, {
    ts: new Date().toISOString(),
    text: text.slice(0, 500),
    toolCalls: (previous && previous.toolCalls ? previous.toolCalls : 0) + (isToolEvent(event) ? 1 : 0),
  });
  return text;
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

function resolveCodex() {
  if (process.platform !== 'win32') {
    return 'codex';
  }

  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `codex${extension}`);

      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return 'codex';
}

function spawnCodex(args, options) {
  const executable = resolveCodex();

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', executable, ...args], options);
  }

  return spawn(executable, args, options);
}

function terminateWorker(child) {
  if (!child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {});
    } catch {
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
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
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

function timeoutMinutes() {
  const value = Number(store.config.taskTimeoutMin);
  return Number.isFinite(value) ? Math.max(1, value) : 45;
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
      store.appendEvent('cancel', { id: task.id, reason });
    } else if (status === 'failed') {
      store.appendEvent('fail', { id: task.id, reason, ...(workerExitedNonzero ? { code: details.exitCode } : {}) });
    } else {
      store.appendEvent('done', { id: task.id, status });
    }
  } catch (error) {
    console.error(`Failed to finish ${task.id}: ${error.message}`);
  } finally {
    runningActivity.delete(task.id);
  }
}

function spawnWorker(task) {
  const model = task.model || store.config.model || 'gpt-5.6-terra';
  const cwd = task.cwd ? path.resolve(task.cwd) : path.join(store.paths.root, 'workspace');
  const outputPath = path.join(store.paths.results, `.${task.id}.${Date.now()}.last-message.tmp`);
  const args = [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '--output-last-message', outputPath,
    '--model', model,
    '-',
  ];
  let child;

  try {
    fs.mkdirSync(cwd, { recursive: true });
    child = spawnCodex(args, {
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

  let lastTextLine = '';
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

    const text = recordActivity(task.id, line);

    if (text) {
      lastTextLine = text;
    }
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
      resultText: readWorkerOutput(outputPath, lastTextLine),
      timedOut,
      cancelled: worker.cancelled,
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
    store.appendEvent('start', { id: task.id });
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
    startTask(task);
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

function dashboardTask(task, activity) {
  const startedAt = taskTime(task, 'startedAt');
  const value = {
    ...task,
    engine: task.engine || 'codex',
    model: task.model || 'default',
  };

  if (!activity) {
    return value;
  }

  return {
    ...value,
    elapsedMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
    lastActivity: activity.text || null,
    toolCalls: activity.toolCalls || 0,
  };
}

function dashboardRecentTask(task) {
  const result = resultForTask(task);
  const value = {
    ...dashboardTask(task),
    prompt: typeof task.prompt === 'string' ? task.prompt : '',
  };

  if (!result) {
    return value;
  }

  for (const field of ['status', 'summary', 'reason', 'durationMs', 'finishedAt', 'costUsd']) {
    if (Object.hasOwn(result, field)) {
      value[field] = result[field];
    }
  }

  return value;
}

function dashboardEvent(event) {
  const id = typeof event.id === 'string' ? event.id : '';
  const task = id ? `task ${id}` : 'task';
  const reason = typeof event.reason === 'string' ? `: ${event.reason}` : '';
  const value = {
    ts: typeof event.ts === 'string' ? event.ts : '',
    kind: 'info',
    text: 'activity',
    ...(id ? { taskId: id } : {}),
  };

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
  const pendingTasks = sortPending(store.listTasks('pending'));
  const runningTasks = store.listTasks('running');
  const completedTasks = store.listTasks('done');
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const done = completedTasks.filter((task) => task.status === 'done').length;
  const failed = completedTasks.filter((task) => task.status === 'failed').length;
  const finishedToday = completedTasks.filter((task) => taskTime(task, 'finishedAt') >= todayStart.getTime()).length;
  const recent = completedTasks
    .sort((left, right) => taskTime(right, 'finishedAt') - taskTime(left, 'finishedAt'))
    .slice(0, 20)
    .map(dashboardRecentTask);

  return {
    daemon: {
      alive: true,
      pid: daemonInfo.pid,
      port: daemonInfo.port,
      startedAt: daemonInfo.startedAt,
      ts: new Date().toISOString(),
    },
    stats: {
      pending: pendingTasks.length,
      running: runningTasks.length,
      done,
      failed,
      today: { tasks: finishedToday },
      totalDone: done,
    },
    tasks: {
      pending: pendingTasks.map((task) => dashboardTask(task)),
      running: runningTasks.map((task) => dashboardTask(task, runningActivity.get(task.id))),
      blocked: [],
      recent,
    },
    messages: [],
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

  const engine = body.engine || 'codex';

  if (engine !== 'codex') {
    sendJson(res, 400, { error: 'Only codex is supported.' });
    return;
  }

  const task = store.enqueueTask({
    prompt: body.prompt,
    engine,
    model: body.model,
    cwd: body.cwd,
    title: body.title,
    priority: body.priority,
    source: 'api',
  });
  store.appendEvent('queue', { id: task.id });

  sendJson(res, 201, { id: task.id });
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
    return decodeURIComponent(requestPath.slice('/api/log/'.length));
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
  const worker = activeWorkers.get(id);

  if (!id) {
    sendJson(res, 400, { error: 'id is required.' });
    return;
  }

  if (!worker) {
    sendJson(res, 404, { error: 'Task is not running.' });
    return;
  }

  if (worker.cancelled) {
    sendJson(res, 409, { error: 'Task is already being cancelled.' });
    return;
  }

  worker.cancelled = true;
  clearTimeout(worker.timeout);
  worker.timeout = null;
  terminateWorker(worker.child);
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
    sendJson(res, 200, daemonState());
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

  if (req.method === 'POST' && requestPath === '/api/cancel') {
    await cancelTask(req, res);
    return;
  }

  if (req.method === 'POST' && ['/api/loop', '/api/answer', '/api/message'].includes(requestPath)) {
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

function stop() {
  stopping = true;
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
};
