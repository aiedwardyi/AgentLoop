// Filesystem-backed task state and daemon configuration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const paths = {
  root,
  config: path.join(root, 'config.json'),
  state: path.join(root, 'state'),
  tasks: path.join(root, 'state', 'tasks'),
  pending: path.join(root, 'state', 'tasks', 'pending'),
  running: path.join(root, 'state', 'tasks', 'running'),
  done: path.join(root, 'state', 'tasks', 'done'),
  results: path.join(root, 'state', 'results'),
  logs: path.join(root, 'state', 'logs'),
  events: path.join(root, 'state', 'events.ndjson'),
  messages: path.join(root, 'state', 'messages.ndjson'),
  daemon: path.join(root, 'state', 'daemon.json'),
  bridge: path.join(root, 'state', 'bridge.json'),
  mcpToken: path.join(root, 'state', 'mcp-token'),
};

// 50 messages x 2000 code points x 4 bytes, plus JSON overhead and headroom.
const maxMessageBytes = 512 * 1024;

const defaults = {
  dashboardPort: 5757,
  maxConcurrent: 2,
  taskTimeoutMin: 45,
  defaultEngine: 'codex',
  mcpBridge: { port: 5758 },
};

function loadConfig() {
  let loaded = {};

  try {
    loaded = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    loaded = {};
  }

  const config = {
    dashboardPort: loaded.dashboardPort ?? defaults.dashboardPort,
    maxConcurrent: loaded.maxConcurrent ?? defaults.maxConcurrent,
    taskTimeoutMin: loaded.taskTimeoutMin ?? defaults.taskTimeoutMin,
    defaultEngine: loaded.defaultEngine ?? defaults.defaultEngine,
    mcpBridge: {
      port: loaded.mcpBridge?.port ?? defaults.mcpBridge.port,
    },
  };

  if (loaded.model) {
    config.model = loaded.model;
  }

  return config;
}

const config = loadConfig();

function ensureDirs() {
  for (const directory of [paths.pending, paths.running, paths.done, paths.results, paths.logs]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function stageDir(stage) {
  if (!['pending', 'running', 'done'].includes(stage)) {
    throw new Error(`Unknown task stage: ${stage}`);
  }

  return paths[stage];
}

function taskPath(id, stage) {
  return path.join(stageDir(stage), `${id}.json`);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );

  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      try {
        fs.unlinkSync(tempPath);
      } catch {
      }
      throw error;
    }

    fs.copyFileSync(tempPath, filePath);
    fs.unlinkSync(tempPath);
  }
}

function moveFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }

    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}

function enqueueTask(partial = {}) {
  const input = partial && typeof partial === 'object' ? partial : {};
  const task = {
    ...input,
    id: `t-${crypto.randomBytes(4).toString('hex')}`,
    type: 'task',
    title: input.title || 'untitled',
    priority: input.priority ?? 5,
    createdAt: new Date().toISOString(),
    source: input.source || 'api',
  };

  writeTask(task, 'pending');
  return task;
}

function enqueueLoop(partial = {}) {
  const input = partial && typeof partial === 'object' ? partial : {};
  const loop = {
    ...input,
    id: `t-${crypto.randomBytes(4).toString('hex')}`,
    type: 'loop',
    title: input.title || `loop: ${input.project || 'untitled'}`,
    priority: input.priority ?? 5,
    cycles: Array.isArray(input.cycles) ? input.cycles : [],
    createdAt: new Date().toISOString(),
    source: input.source || 'api',
  };

  writeTask(loop, 'pending');
  return loop;
}

function moveTask(id, fromStage, toStage) {
  ensureDirs();
  moveFile(taskPath(id, fromStage), taskPath(id, toStage));
}

function readTask(id, stage) {
  return JSON.parse(fs.readFileSync(taskPath(id, stage), 'utf8'));
}

function writeTask(task, stage) {
  if (!task || !task.id) {
    throw new Error('Task id is required.');
  }

  ensureDirs();
  writeJsonAtomic(taskPath(task.id, stage), task);
}

function listTasks(stage) {
  ensureDirs();

  return fs.readdirSync(stageDir(stage), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(stageDir(stage), entry.name), 'utf8')));
}

function writeResult(result) {
  if (!result || !result.id) {
    throw new Error('Result id is required.');
  }

  ensureDirs();
  writeJsonAtomic(path.join(paths.results, `${result.id}.json`), result);
}

function logPath(id) {
  return path.join(paths.logs, `${id}.ndjson`);
}

function appendLogLine(id, line) {
  if (!id) {
    throw new Error('Task id is required.');
  }

  ensureDirs();
  const value = String(line ?? '').replace(/[\r\n]+/g, ' ');
  fs.appendFileSync(logPath(id), `${value}\n`, 'utf8');
}

function readLogLines(id, limit = 200) {
  try {
    const lines = fs.readFileSync(logPath(id), 'utf8').split(/\r?\n/);

    if (lines[lines.length - 1] === '') {
      lines.pop();
    }

    return lines.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

function appendEvent(type, dataObj = {}) {
  try {
    ensureDirs();
    const event = {
      ...(dataObj && typeof dataObj === 'object' ? dataObj : {}),
      type,
      ts: new Date().toISOString(),
    };

    fs.appendFileSync(paths.events, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  } catch {
    return null;
  }
}

function appendMessage(partial = {}) {
  const input = partial && typeof partial === 'object' ? partial : {};
  const message = {
    id: `m-${crypto.randomBytes(4).toString('hex')}`,
    ts: new Date().toISOString(),
    kind: input.kind,
    text: input.text,
  };

  ensureDirs();
  fs.appendFileSync(paths.messages, `${JSON.stringify(message)}\n`, 'utf8');
  return message;
}

function readMessages(limit = 50) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : 50;

  try {
    const size = fs.statSync(paths.messages).size;

    if (!size) {
      return [];
    }

    const length = Math.min(size, maxMessageBytes);
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(paths.messages, 'r');
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

    const messages = [];

    for (const line of lines.reverse()) {
      try {
        const message = JSON.parse(line);

        if (message && typeof message === 'object' && !Array.isArray(message)) {
          messages.push(message);
          if (messages.length === max) {
            break;
          }
        }
      } catch {
      }
    }

    return messages;
  } catch {
    return [];
  }
}

function heartbeatValue(heartbeat) {
  return {
    ...heartbeat,
    ts: new Date().toISOString(),
  };
}

function writeExclusiveHeartbeat(value) {
  let fd;

  try {
    fd = fs.openSync(paths.daemon, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function acquireHeartbeat(heartbeat) {
  ensureDirs();
  const value = heartbeatValue(heartbeat);

  try {
    writeExclusiveHeartbeat(value);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }

  const existing = readHeartbeat();

  if (isAlive(existing)) {
    return false;
  }

  if (!existing) {
    let age;

    try {
      age = Date.now() - fs.statSync(paths.daemon).mtimeMs;
    } catch {
      return false;
    }

    if (!Number.isFinite(age) || age < 15000) {
      return false;
    }
  }

  try {
    fs.unlinkSync(paths.daemon);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    writeExclusiveHeartbeat(value);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

function writeHeartbeat(heartbeat) {
  const value = heartbeatValue(heartbeat);

  ensureDirs();
  writeJsonAtomic(paths.daemon, value);
  return value;
}

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(paths.daemon, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(heartbeat = readHeartbeat()) {
  const timestamp = heartbeat && Date.parse(heartbeat.ts);
  const pid = heartbeat && Number(heartbeat.pid);

  if (!Number.isFinite(timestamp) || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (Date.now() - timestamp >= 15000) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

module.exports = {
  config,
  paths,
  ensureDirs,
  enqueueTask,
  enqueueLoop,
  moveTask,
  readTask,
  writeTask,
  listTasks,
  writeResult,
  appendLogLine,
  readLogLines,
  appendEvent,
  appendMessage,
  readMessages,
  acquireHeartbeat,
  writeHeartbeat,
  readHeartbeat,
  isAlive,
};
