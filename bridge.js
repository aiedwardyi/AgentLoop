const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const statePath = path.join(root, 'state');
const logsPath = path.join(statePath, 'logs');
const configPath = path.join(root, 'config.json');
const heartbeatPath = path.join(statePath, 'bridge.json');
const tokenPath = path.join(statePath, 'mcp-token');
const protocolVersion = '2025-06-18';
const supportedVersions = new Set(['2024-11-05', '2025-03-26', protocolVersion]);
const maxBodyBytes = 1000000;

let bridgeToken;
let heartbeatTimer;
let server;
let startedAt;
let shuttingDown = false;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function bridgePort() {
  const port = Number(loadConfig().mcpBridge?.port);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 5758;
}

function dashboardPort() {
  const port = Number(loadConfig().dashboardPort);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 5757;
}

function log(message) {
  try {
    fs.mkdirSync(logsPath, { recursive: true });
    fs.appendFileSync(path.join(logsPath, 'bridge.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
  }
}

function storedToken() {
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return '';
  }
}

function readToken() {
  while (true) {
    const existing = storedToken();

    if (existing) {
      return existing;
    }

    try {
      fs.unlinkSync(tokenPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    const token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(statePath, { recursive: true });

    try {
      fs.writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

function writeHeartbeat() {
  fs.mkdirSync(statePath, { recursive: true });
  fs.writeFileSync(heartbeatPath, `${JSON.stringify({
    pid: process.pid,
    port: bridgePort(),
    startedAt,
    ts: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

function clearHeartbeat() {
  try {
    const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));

    if (heartbeat.pid !== process.pid) {
      return;
    }
  } catch {
  }

  try {
    fs.unlinkSync(heartbeatPath);
  } catch {
  }
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendEmpty(res, statusCode, headers = {}) {
  res.writeHead(statusCode, { 'cache-control': 'no-store', ...headers });
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);

      if (size > maxBodyBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }

      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function timingSafeEqual(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function authorized(req, requestUrl) {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : null;
  const candidate = match ? match[1].trim() : requestUrl.searchParams.get('key') || '';

  if (!candidate || !bridgeToken) {
    return false;
  }

  return timingSafeEqual(candidate, bridgeToken);
}

function daemonRequest(requestPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      hostname: '127.0.0.1',
      port: dashboardPort(),
      path: requestPath,
      method: data ? 'POST' : 'GET',
      headers: data ? {
        'content-type': 'application/json',
        'content-length': data.length,
      } : {},
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let value = null;

        try {
          value = text ? JSON.parse(text) : null;
        } catch {
          value = null;
        }

        resolve({ statusCode: response.statusCode || 500, value });
      });
    });

    request.setTimeout(10000, () => request.destroy(new Error('Daemon request timed out.')));
    request.on('error', reject);
    request.end(data || undefined);
  });
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusSnapshot(state) {
  const stats = state && typeof state.stats === 'object' ? state.stats : {};
  const tasks = state && typeof state.tasks === 'object' ? state.tasks : {};
  const running = Array.isArray(tasks.running) ? tasks.running : [];
  const recent = Array.isArray(tasks.recent) ? tasks.recent : [];

  return {
    daemonAlive: state?.daemon?.alive === true,
    counts: {
      pending: numeric(stats.pending),
      running: numeric(stats.running),
      done: numeric(stats.done),
      failed: numeric(stats.failed),
    },
    runningTasks: running.map((task) => ({
      id: task.id,
      title: task.title,
      elapsed: numeric(task.elapsedMs),
    })),
    recentResults: recent.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status || task.result?.status || null,
    })),
  };
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolFailure(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

const tools = [
  {
    name: 'agentloop_status',
    description: 'Read the current AgentLoop status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dispatch_task',
    description: 'Dispatch a task to AgentLoop.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string' },
        engine: { type: 'string', enum: ['codex'] },
      },
      required: ['title', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'start_loop',
    description: 'Start an AgentLoop project loop.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        maxCycles: { type: 'integer', minimum: 1, maximum: 10 },
        engine: { type: 'string', enum: ['codex'] },
        polish: { type: 'boolean', default: false, description: 'keep improving after the plan passes' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'send_message',
    description: 'Post short progress updates, questions for the human, and final result summaries to the AgentLoop dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        kind: { type: 'string', enum: ['info', 'question', 'results'], default: 'info' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
];

function daemonError(response) {
  return response.value && typeof response.value.error === 'string'
    ? response.value.error
    : `Daemon request failed (${response.statusCode}).`;
}

async function callTool(params) {
  const name = params && typeof params.name === 'string' ? params.name : '';
  const args = params && params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments
    : {};

  if (name === 'agentloop_status') {
    try {
      const response = await daemonRequest('/api/state');
      return toolResult(statusSnapshot(response.statusCode === 200 ? response.value : null));
    } catch {
      return toolResult(statusSnapshot(null));
    }
  }

  if (name === 'dispatch_task') {
    const response = await daemonRequest('/api/dispatch', {
      title: args.title,
      prompt: args.prompt,
      engine: args.engine,
      source: 'mcp',
    });

    return response.statusCode >= 200 && response.statusCode < 300
      ? toolResult({ id: response.value?.id })
      : toolFailure(daemonError(response));
  }

  if (name === 'start_loop') {
    const response = await daemonRequest('/api/loop', {
      project: args.project,
      maxCycles: args.maxCycles,
      engine: args.engine,
      polish: args.polish,
      source: 'mcp',
    });

    return response.statusCode >= 200 && response.statusCode < 300
      ? toolResult({ id: response.value?.id })
      : toolFailure(daemonError(response));
  }

  if (name === 'send_message') {
    const response = await daemonRequest('/api/message', {
      text: args.text,
      kind: args.kind,
    });

    return response.statusCode >= 200 && response.statusCode < 300
      ? toolResult(response.value)
      : toolFailure(daemonError(response));
  }

  return toolFailure(`Unknown tool: ${name}.`);
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request.');
  }

  const notification = !Object.hasOwn(message, 'id');
  const id = notification ? null : message.id;
  let result;

  try {
    if (message.method === 'initialize') {
      const requestedVersion = message.params?.protocolVersion;
      result = {
        protocolVersion: supportedVersions.has(requestedVersion) ? requestedVersion : protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'agentloop', version: '0.1.0' },
      };
    } else if (message.method === 'notifications/initialized' || message.method === 'ping') {
      result = {};
    } else if (message.method === 'tools/list') {
      result = { tools };
    } else if (message.method === 'tools/call') {
      result = await callTool(message.params);
    } else if (message.method === 'resources/list') {
      result = { resources: [] };
    } else if (message.method === 'prompts/list') {
      result = { prompts: [] };
    } else {
      return notification ? null : rpcError(id, -32601, 'Method not found.');
    }
  } catch (error) {
    return notification ? null : rpcError(id, -32603, error.message || 'Internal error.');
  }

  return notification ? null : rpcResult(id, result);
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');

  if (!['/', '/mcp'].includes(requestUrl.pathname)) {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }

  if (req.method !== 'POST') {
    sendEmpty(res, 405, { allow: 'POST' });
    return;
  }

  if (!authorized(req, requestUrl)) {
    sendJson(res, 401, rpcError(null, -32001, 'Unauthorized.'));
    return;
  }

  let payload;

  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, rpcError(null, -32700, error.message));
    return;
  }

  const batch = Array.isArray(payload);

  if (batch && payload.length === 0) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request.'));
    return;
  }

  const messages = batch ? payload : [payload];
  const responses = [];

  for (const message of messages) {
    const response = await handleMessage(message);

    if (response) {
      responses.push(response);
    }
  }

  if (!responses.length) {
    sendEmpty(res, 202);
    return;
  }

  sendJson(res, 200, batch ? responses : responses[0]);
}

function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(heartbeatTimer);
  clearHeartbeat();
  log('stopped');

  if (!server) {
    process.exit(0);
    return;
  }

  server.close(() => process.exit(0));
}

function start() {
  bridgeToken = readToken();
  startedAt = new Date().toISOString();
  writeHeartbeat();
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, rpcError(null, -32603, error.message || 'Internal error.'));
    });
  });
  server.on('error', (error) => {
    clearHeartbeat();
    log(`error: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(bridgePort(), '127.0.0.1', () => {
    writeHeartbeat();
    heartbeatTimer = setInterval(writeHeartbeat, 5000);
    log('started');
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
start();
