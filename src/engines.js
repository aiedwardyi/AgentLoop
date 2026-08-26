// Engine registry: how to find each coding CLI, drive it, and read its event stream.
// Adding an engine means adding one entry here; the daemon stays engine-agnostic.
const fs = require('node:fs');
const path = require('node:path');

function findOnPath(command) {
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);

      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function parseJsonLine(line) {
  try {
    const event = JSON.parse(line);
    return event && typeof event === 'object' ? event : null;
  } catch {
    return null;
  }
}

function toolSummary(name, input) {
  const detail = input && typeof input === 'object'
    ? input.command || input.file_path || input.path || input.pattern || input.description
    : '';

  return detail ? `${name}: ${String(detail).slice(0, 120)}` : String(name || 'tool');
}

const codexToolItems = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

const codex = {
  id: 'codex',
  label: 'Codex',
  command: 'codex',
  defaultModel: 'gpt-5.6-terra',
  installHint: 'npm i -g @openai/codex',
  // Codex writes its final message to a file rather than emitting it as an event.
  usesOutputFile: true,

  args({ model, outputPath }) {
    return [
      'exec',
      '--json',
      '--sandbox', 'workspace-write',
      '--config', 'approval_policy="on-request"',
      '--config', 'approvals_reviewer="auto_review"',
      '--config', 'sandbox_workspace_write.network_access=false',
      '--skip-git-repo-check',
      '--output-last-message', outputPath,
      '--model', model,
      '-',
    ];
  },

  parseLine(line) {
    const event = parseJsonLine(line);

    if (!event) {
      return { text: line };
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
    const tool = event.type === 'item.completed' && codexToolItems.has(item.type);

    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        return { text: candidate, tool };
      }
    }

    return { text: typeof event.type === 'string' ? event.type : line, tool };
  },
};

const claude = {
  id: 'claude',
  label: 'Claude Code',
  command: 'claude',
  defaultModel: 'opus',
  installHint: 'npm i -g @anthropic-ai/claude-code',
  usesOutputFile: false,

  args({ model }) {
    return [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      // A worker must start fresh: safe-mode drops the operator's CLAUDE.md, hooks, skills, and MCP servers.
      '--safe-mode',
      '--strict-mcp-config',
      '--permission-mode', 'acceptEdits',
      '--disallowedTools', 'WebFetch,WebSearch',
      '--model', model,
    ];
  },

  // A daemon launched from inside Claude Code leaks these, and the worker then thinks it is a nested session.
  env(base) {
    const env = { ...base };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SSE_PORT;
    return env;
  },

  parseLine(line) {
    const event = parseJsonLine(line);

    if (!event) {
      return { text: line };
    }

    if (event.type === 'system' && event.subtype === 'init') {
      return { text: 'session started' };
    }

    if (event.type === 'result') {
      const costUsd = event.total_cost_usd;

      return {
        text: 'session finished',
        result: typeof event.result === 'string' ? event.result : '',
        ...(typeof costUsd === 'number' && Number.isFinite(costUsd) ? { costUsd } : {}),
      };
    }

    const content = event.type === 'assistant' && event.message && Array.isArray(event.message.content)
      ? event.message.content
      : [];
    let parsed = null;

    for (const block of content) {
      if (block && block.type === 'tool_use') {
        parsed = { text: toolSummary(block.name, block.input), tool: true };
      } else if (block && block.type === 'text' && block.text) {
        parsed = { text: block.text, message: true };
      }
    }

    return parsed || { text: '' };
  },
};

const registry = new Map([[claude.id, claude], [codex.id, codex]]);
const resolved = new Map();

function get(id) {
  return registry.get(id) || null;
}

function has(id) {
  return registry.has(id);
}

function ids() {
  return [...registry.keys()];
}

// Cached: PATH does not change under a running daemon, and this shells out on every dashboard poll otherwise.
function binary(engine, enginePaths = {}) {
  if (enginePaths[engine.id]) {
    return enginePaths[engine.id];
  }

  if (!resolved.has(engine.id)) {
    resolved.set(engine.id, findOnPath(engine.command));
  }

  return resolved.get(engine.id);
}

function available(engine, enginePaths) {
  return Boolean(binary(engine, enginePaths));
}

function modelFor(engine, config, override) {
  return override
    || (config.models && config.models[engine.id])
    || config.model
    || engine.defaultModel;
}

module.exports = {
  get,
  has,
  ids,
  binary,
  available,
  modelFor,
  findOnPath,
};
