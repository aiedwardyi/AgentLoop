// MCP tool definitions and dispatch, shared by both transports (bridge.js http, mcp-server.js stdio).
const http = require('node:http');

const store = require('./store');

// A non-numeric config value reaches http.request as-is and fails every tool call.
function dashboardPort() {
  const parsed = Number(store.config.dashboardPort);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 5757;
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
        engine: { type: 'string', enum: ['claude', 'codex'] },
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
        maxCycles: { type: 'integer', minimum: 1, maximum: 50 },
        taskRetries: { type: 'integer', minimum: 1, maximum: 10, description: 'failed cycles per task before it is blocked and skipped' },
        engine: { type: 'string', enum: ['claude', 'codex'] },
        polish: { type: 'boolean', default: false, description: 'keep improving after the plan passes' },
        autoCommit: { type: 'boolean', default: true, description: 'daemon makes a local git checkpoint commit after each completed task' },
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
      taskRetries: args.taskRetries,
      engine: args.engine,
      polish: args.polish,
      autoCommit: args.autoCommit,
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
      ? toolResult(response.value && typeof response.value === 'object' ? response.value : { ok: true })
      : toolFailure(daemonError(response));
  }

  return toolFailure(`Unknown tool: ${name}.`);
}

module.exports = { tools, callTool };
