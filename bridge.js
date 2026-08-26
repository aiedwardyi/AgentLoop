const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { tools, callTool } = require('./src/tools');

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
