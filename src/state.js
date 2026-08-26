// Contract shapes for GET /api/state: whitelisted fields, folder basenames only,
// optional metrics omitted when unknown - a placeholder 0 renders as a dead metric.

// Server port of the dashboard's stripPaths. The drive and UNC variants also
// catch spaced segments ("C:\Program Files\...") the shared pattern cannot.
const posixPathPattern = /(?<![\w:.\/\\])(?:[A-Za-z]:)?(?:[\/\\]|~[\/\\])[\w.@~-]+(?:[\/\\][\w.@ ~-]+)+[\/\\]?/g;
const drivePathPattern = /[A-Za-z]:[\\\/](?:[^\\\/:*?"<>|\r\n]+[\\\/])+[\w.@~-]+[\\\/]?/g;
const uncPathPattern = /\\\\[\w.$-]+(?:[\\\/][^\\\/:*?"<>|\r\n]+)*[\\\/][\w.@~-]+[\\\/]?/g;

function lastSegment(value) {
  const segments = String(value ?? '').split(/[\\\/]/).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : String(value ?? '');
}

function stripAbsPaths(text) {
  return String(text)
    .replace(uncPathPattern, lastSegment)
    .replace(drivePathPattern, lastSegment)
    .replace(posixPathPattern, lastSegment);
}

function sanitizeState(value) {
  if (typeof value === 'string') {
    return stripAbsPaths(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeState);
  }

  if (value && typeof value === 'object') {
    const clean = {};

    for (const key of Object.keys(value)) {
      clean[key] = sanitizeState(value[key]);
    }

    return clean;
  }

  return value;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundCost(value) {
  return Math.round(value * 10000) / 10000;
}

function sumCycleCosts(cycles, sinceMs = 0) {
  let sum = null;

  for (const cycle of Array.isArray(cycles) ? cycles : []) {
    if (!cycle) {
      continue;
    }

    const cost = finiteNumber(cycle.costUsd) ?? finiteNumber(cycle.workerCostUsd);

    if (cost === null) {
      continue;
    }

    if (sinceMs && !(Date.parse(cycle.finishedAt || '') >= sinceMs)) {
      continue;
    }

    sum = (sum || 0) + cost;
  }

  return sum === null ? null : roundCost(sum);
}

function projectName(task) {
  return lastSegment(task.projectPath || task.project || '') || 'untitled';
}

function displayTitle(task) {
  if (task.type === 'loop') {
    return `loop: ${projectName(task)}`;
  }

  return typeof task.title === 'string' && task.title ? task.title : 'untitled';
}

function publicPending(task, defaultEngine) {
  return {
    id: task.id,
    type: task.type,
    title: displayTitle(task),
    ...(task.type === 'loop' ? { project: projectName(task) } : {}),
    engine: task.engine || defaultEngine,
    createdAt: task.createdAt,
  };
}

function checkpointsField(loop) {
  if (loop.autoCommit !== true) {
    return false;
  }

  return Array.isArray(loop.checkpointShas) ? loop.checkpointShas.length : 0;
}

function cycleView(cycle) {
  const polish = cycle.phase === 'polish';
  const status = cycle.status === 'passed'
    ? (cycle.verdict === 'SHIP' ? 'ship' : 'pass')
    : cycle.status === 'failed' ? 'fail' : cycle.status;
  const task = finiteNumber(cycle.task);
  const costUsd = finiteNumber(cycle.costUsd) ?? finiteNumber(cycle.workerCostUsd);
  const durationMs = finiteNumber(cycle.durationMs);

  return {
    n: cycle.n,
    ...(task !== null && !polish ? { task } : {}),
    status,
    ...(polish ? { phase: 'polish' } : {}),
    ...(typeof cycle.summary === 'string' && cycle.summary ? { summary: cycle.summary } : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
  };
}

// Chronological walk: every CONTINUE or blocked cycle advances one plan position,
// fail streaks burn tries in place, and a PASS completes every position left.
function planView(loop) {
  const titles = Array.isArray(loop.planTasks) ? loop.planTasks : [];

  if (!titles.length) {
    return null;
  }

  const budget = finiteNumber(loop.taskRetries) ?? 3;
  const shaByTask = new Map();
  let passSha = null;

  for (const entry of Array.isArray(loop.checkpointShas) ? loop.checkpointShas : []) {
    if (!entry || typeof entry.sha !== 'string') {
      continue;
    }

    if (finiteNumber(entry.task) !== null) {
      shaByTask.set(entry.task, entry.sha);
    } else {
      passSha = entry.sha;
    }
  }

  const walked = new Map();
  let position = 1;
  let tries = 0;
  let passed = false;

  for (const cycle of Array.isArray(loop.cycles) ? loop.cycles : []) {
    if (!cycle || cycle.phase === 'polish') {
      continue;
    }

    if (cycle.status === 'continue' || cycle.status === 'blocked') {
      walked.set(position, {
        status: cycle.status === 'continue' ? 'done' : 'blocked',
        tries: cycle.status === 'continue' ? tries + 1 : budget,
        checkpoint: shaByTask.get(finiteNumber(cycle.task) ?? position),
        note: cycle.status === 'blocked' && typeof cycle.fixes === 'string' && cycle.fixes ? cycle.fixes : undefined,
      });
      position += 1;
      tries = 0;
    } else if (cycle.status === 'passed') {
      passed = true;
    } else if (cycle.status === 'failed' || cycle.status === 'critic_invalid') {
      tries += 1;
    }
  }

  const tasks = titles.map((title, index) => {
    const n = index + 1;
    const entry = walked.get(n);
    const value = { n, title, status: 'pending', tries: 0, budget };

    if (entry) {
      value.status = entry.status;
      value.tries = entry.tries;

      if (entry.checkpoint) {
        value.checkpoint = entry.checkpoint;
      }

      if (entry.note) {
        value.note = entry.note;
      }
    } else if (passed) {
      value.status = 'done';
      value.tries = n === position ? tries + 1 : 1;
      const sha = shaByTask.get(n) ?? passSha;

      if (sha) {
        value.checkpoint = sha;
      }
    } else if (n === position) {
      value.status = 'active';
      value.tries = (finiteNumber(loop.failStreak) || 0) + 1;
    }

    return value;
  });

  return { file: 'PLAN.md', rubric: 'GUIDELINES.md', tasks };
}

function publicRunning(task, activity, defaultEngine, now = Date.now()) {
  const startedMs = Date.parse(task.startedAt || '');
  const value = {
    id: task.id,
    type: task.type,
    title: displayTitle(task),
    ...(task.type === 'loop' ? { project: projectName(task) } : {}),
    engine: task.engine || defaultEngine,
    startedAt: task.startedAt,
    elapsedMs: Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0,
    ...(activity && activity.text ? { lastActivity: activity.text } : {}),
    ...(activity ? { toolCalls: finiteNumber(activity.toolCalls) ?? 0 } : {}),
  };

  if (task.type !== 'loop') {
    return value;
  }

  const cycle = finiteNumber(task.cycle);
  const maxCycles = finiteNumber(task.maxCycles);
  const cycles = Array.isArray(task.cycles) ? task.cycles.filter(Boolean) : [];
  const plan = planView(task);

  return {
    ...value,
    ...(cycle ? { cycle } : {}),
    ...(maxCycles !== null ? { maxCycles } : {}),
    checkpoints: checkpointsField(task),
    ...(cycles.length ? { cycles: cycles.map(cycleView) } : {}),
    ...(plan ? { plan } : {}),
  };
}

function publicRecent(task, result, defaultEngine) {
  const merged = { ...task, ...(result && typeof result === 'object' ? result : {}) };
  const costUsd = finiteNumber(merged.costUsd) ?? (task.type === 'loop' ? sumCycleCosts(task.cycles) : null);
  const value = {
    id: task.id,
    type: task.type,
    title: displayTitle(task),
    engine: task.engine || defaultEngine,
    status: merged.status,
    summary: typeof merged.summary === 'string' ? merged.summary : '',
    ...(costUsd !== null ? { costUsd } : {}),
    durationMs: finiteNumber(merged.durationMs) ?? 0,
    finishedAt: merged.finishedAt,
  };

  if (task.type !== 'loop') {
    return value;
  }

  const tasksDone = Array.isArray(task.done) ? task.done.length : 0;
  const tasksBlocked = Array.isArray(task.blocked) ? task.blocked.length : 0;

  return {
    ...value,
    ...(tasksDone || tasksBlocked ? { tasksDone } : {}),
    ...(tasksBlocked ? { tasksBlocked } : {}),
    checkpoints: checkpointsField(task),
  };
}

module.exports = {
  stripAbsPaths,
  sanitizeState,
  roundCost,
  sumCycleCosts,
  cycleView,
  planView,
  publicPending,
  publicRunning,
  publicRecent,
};
