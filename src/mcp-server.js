// MCP server for Claude Desktop: JSON-RPC 2.0 over newline-delimited stdio, zero dependencies.
// Tool definitions live in tools.js, shared with the HTTP bridge (bridge.js).
const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');
const { tools, callTool } = require('./tools');

const protocolVersion = '2025-06-18';
const supportedVersions = new Set(['2024-11-05', '2025-03-26', protocolVersion]);

function log(message) {
  try {
    fs.mkdirSync(store.paths.logs, { recursive: true });
    fs.appendFileSync(path.join(store.paths.logs, 'mcp.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
  }
}

// stdout carries JSON-RPC only; anything else corrupts the transport.
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request.' } };
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
      return notification ? null : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } };
    }
  } catch (error) {
    return notification ? null : { jsonrpc: '2.0', id, error: { code: -32603, message: error.message || 'Internal error.' } };
  }

  return notification ? null : { jsonrpc: '2.0', id, result };
}

let buffered = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;

  let index;

  while ((index = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, index).trim();
    buffered = buffered.slice(index + 1);

    if (!line) {
      continue;
    }

    let message;

    try {
      message = JSON.parse(line);
    } catch {
      log(`bad json: ${line.slice(0, 200)}`);
      continue;
    }

    handleMessage(message).then((response) => {
      if (response) {
        send(response);
      }
    });
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (error) => log(`uncaught: ${error.stack || error.message}`));
log('started');
