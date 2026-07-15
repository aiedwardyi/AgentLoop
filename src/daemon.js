// Daemon scheduler, worker runner, and local HTTP API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const store = require('./store');
const { taskPrompt, parseLoopResult } = require('./prompts');

const pollMs = 1500;
const maxResultText = 20000;
const runningActivity = new Map();

let daemonInfo;
let server;
let ticker;

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

function eventText(line) {
  try {
    const event = JSON.parse(line);
    const candidates = [
      event.text,
      event.message,
      event.content,
      event.item && event.item.text,
      event.item && event.item.content,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        return candidate;
      }
    }
  } catch {
  }

  return line;
}

function recordActivity(id, line) {
  const text = eventText(line).trim();

  if (!text) {
    return '';
  }

  runningActivity.set(id, {
    ts: new Date().toISOString(),
    text: text.slice(0, 500),
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

function fallbackSummary(text, status, timedOut) {
  if (timedOut) {
    return `Worker timed out after ${store.config.taskTimeoutMin} minutes.`;
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
  const parsed = details.forceFailed || details.timedOut
    ? null
    : parseLoopResult(details.resultText);
  const status = details.forceFailed || details.timedOut
    ? 'failed'
    : parsed ? parsed.status : details.exitCode === 0 ? 'done' : 'failed';
  const result = {
    id: task.id,
    status,
    summary: parsed && parsed.summary
      ? parsed.summary
      : fallbackSummary(details.resultText, status, details.timedOut),
    resultText: trimResult(details.resultText),
    exitCode: details.exitCode,
    durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
    finishedAt,
  };
  const completedTask = {
    ...task,
    status,
    finishedAt,
  };

  try {
    store.writeResult(result);
    store.writeTask(completedTask, 'running');
    store.moveTask(task.id, 'running', 'done');
    store.appendEvent('done', { id: task.id, status });
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
      resultText: `Worker failed to start: ${error.message}`,
      timedOut: false,
    });
    return;
  }

  let lastTextLine = '';
  let timedOut = false;
  let settled = false;
  let timeout;
  const captureLine = (line) => {
    const text = recordActivity(task.id, line);

    if (text) {
      lastTextLine = text;
    }
  };
  const finish = (exitCode) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timeout);
    completeTask(task, {
      exitCode,
      forceFailed: false,
      resultText: readWorkerOutput(outputPath, lastTextLine),
      timedOut,
    });
  };

  streamLines(child.stdout, captureLine);
  streamLines(child.stderr, captureLine);
  child.once('error', (error) => {
    lastTextLine = `Worker error: ${error.message}`;
    finish(null);
  });
  child.once('close', (code) => finish(code));
  child.stdin.on('error', (error) => {
    lastTextLine = `Worker input error: ${error.message}`;
  });

  const timeoutMinutes = Math.max(1, Number(store.config.taskTimeoutMin) || 45);
  timeout = setTimeout(() => {
    timedOut = true;
    lastTextLine = `Worker timed out after ${timeoutMinutes} minutes.`;
    terminateWorker(child);
  }, timeoutMinutes * 60 * 1000);

  try {
    child.stdin.end(taskPrompt(task));
  } catch (error) {
    lastTextLine = `Worker input error: ${error.message}`;
    finish(null);
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
    });
    spawnWorker(runningTask);
  } catch (error) {
    completeTask(runningTask, {
      exitCode: null,
      forceFailed: true,
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

function daemonState() {
  const running = store.listTasks('running').map((task) => ({
    ...task,
    lastActivity: runningActivity.get(task.id) || null,
  }));
  const pending = sortPending(store.listTasks('pending'));
  const recent = store.listTasks('done')
    .sort((left, right) => taskTime(right, 'finishedAt') - taskTime(left, 'finishedAt'))
    .slice(0, 20);

  return {
    daemon: {
      alive: true,
      port: daemonInfo.port,
      startedAt: daemonInfo.startedAt,
    },
    running,
    pending,
    recent,
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
  const dashboardPath = path.join(store.paths.root, 'dashboard', 'index.html');

  if (fs.existsSync(dashboardPath)) {
    send(res, 200, fs.readFileSync(dashboardPath), 'text/html; charset=utf-8');
    return;
  }

  send(res, 200, '<!doctype html><p>AgentLoop daemon is running.</p>', 'text/html; charset=utf-8');
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

  if (body.engine && body.engine !== 'codex') {
    sendJson(res, 400, { error: 'Only codex is supported.' });
    return;
  }

  const task = store.enqueueTask({
    prompt: body.prompt,
    engine: 'codex',
    model: body.model,
    cwd: body.cwd,
    title: body.title,
    priority: body.priority,
    source: 'api',
  });

  sendJson(res, 201, { id: task.id });
}

async function handleRequest(req, res) {
  const requestPath = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && (requestPath === '/' || requestPath === '/index.html')) {
    serveDashboard(res);
    return;
  }

  if (req.method === 'GET' && requestPath === '/api/state') {
    sendJson(res, 200, daemonState());
    return;
  }

  if (req.method === 'POST' && requestPath === '/api/dispatch') {
    await dispatch(req, res);
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
    console.log(`Dashboard: http://127.0.0.1:${daemonInfo.port}`);
  });

  ticker = setInterval(tick, pollMs);
  tick();
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
