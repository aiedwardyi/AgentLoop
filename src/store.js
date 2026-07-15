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
  events: path.join(root, 'state', 'events.ndjson'),
  daemon: path.join(root, 'state', 'daemon.json'),
};

const defaults = {
  dashboardPort: 5757,
  maxConcurrent: 2,
  taskTimeoutMin: 45,
  defaultEngine: 'codex',
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
  };

  if (loaded.model) {
    config.model = loaded.model;
  }

  return config;
}

const config = loadConfig();

function ensureDirs() {
  for (const directory of [paths.pending, paths.running, paths.done, paths.results]) {
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

function appendEvent(type, dataObj = {}) {
  ensureDirs();
  const event = {
    ...(dataObj && typeof dataObj === 'object' ? dataObj : {}),
    type,
    ts: new Date().toISOString(),
  };

  fs.appendFileSync(paths.events, `${JSON.stringify(event)}\n`, 'utf8');
  return event;
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
  moveTask,
  readTask,
  writeTask,
  listTasks,
  writeResult,
  appendEvent,
  acquireHeartbeat,
  writeHeartbeat,
  readHeartbeat,
  isAlive,
};
