const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const daemon = require('../src/daemon');
const store = require('../src/store');

const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.js'), 'utf8');

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-test-'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });

  if (git('init', '-q').status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }

  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');

  return { dir, git };
}

test('a second block names its own task number and plan item', () => {
  const loop = {
    planTasks: ['build parser', 'wire CLI', 'ship docs'],
    done: ['build parser'],
    blocked: [{ task: 2, item: 'wire CLI' }],
    nextItem: 'wire CLI',
  };

  assert.deepEqual(daemon.blockedEntry(loop, { n: 5, task: 3 }), { task: 3, item: 'ship docs' });
});

test('a blocked entry falls back to the walked plan position', () => {
  const loop = { planTasks: ['one', 'two', 'three'], done: ['one'], blocked: [{ task: 2, item: 'two' }] };

  assert.deepEqual(daemon.blockedEntry(loop, null), { task: 3, item: 'three' });
  assert.deepEqual(daemon.blockedEntry({ nextItem: 'only hint' }, null), { task: 1, item: 'only hint' });
  assert.deepEqual(daemon.blockedEntry({}, null), { task: 1, item: 'first PLAN.md item' });
});

test('a worker that commits its own changes counts as progress', () => {
  const before = { head: 'aaa', tree: ' M src/app.js' };

  assert.equal(daemon.madeNoChanges(before, { head: 'aaa', tree: ' M src/app.js' }), true);
  assert.equal(daemon.madeNoChanges(before, { head: 'bbb', tree: '' }), false);
  assert.equal(daemon.madeNoChanges(before, { head: 'aaa', tree: ' M src/app.js\n M PLAN.md' }), false);
});

test('an edit to an already-dirty file counts as progress', () => {
  const before = { head: 'aaa', tree: ' M src/app.js', dirty: 'one' };

  assert.equal(daemon.madeNoChanges(before, { head: 'aaa', tree: ' M src/app.js', dirty: 'one' }), true);
  assert.equal(daemon.madeNoChanges(before, { head: 'aaa', tree: ' M src/app.js', dirty: 'two' }), false);
});

test('the tree snapshot sees content, not just status codes', (t) => {
  const repo = tempRepo();

  if (!repo) {
    t.skip('git unavailable');
    return;
  }

  try {
    const file = path.join(repo.dir, 'app.js');
    fs.writeFileSync(file, 'first\n');
    repo.git('add', '-A', '.');
    repo.git('commit', '-qm', 'seed');
    fs.writeFileSync(file, 'second\n');
    fs.writeFileSync(path.join(repo.dir, 'STATE.md'), 'notes\n');

    const before = daemon.gitSnapshot(repo.dir);
    fs.writeFileSync(file, 'third\n');
    fs.writeFileSync(path.join(repo.dir, 'STATE.md'), 'more notes\n');

    const after = daemon.gitSnapshot(repo.dir);

    assert.equal(before.tree, after.tree);
    assert.notEqual(before.dirty, after.dirty);
    assert.equal(daemon.madeNoChanges(before, after), false);
    assert.equal(daemon.madeNoChanges(before, daemon.gitSnapshot(repo.dir)), false);
    assert.equal(daemon.madeNoChanges(after, daemon.gitSnapshot(repo.dir)), true);
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('a sibling project commit never blocks a queued loop', (t) => {
  const repo = tempRepo();

  if (!repo) {
    t.skip('git unavailable');
    return;
  }

  try {
    const project = path.join(repo.dir, 'project');
    const sibling = path.join(repo.dir, 'sibling');

    fs.mkdirSync(project);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(project, 'app.js'), 'one\n');
    fs.writeFileSync(path.join(sibling, 'app.js'), 'one\n');
    repo.git('add', '-A', '.');
    repo.git('commit', '-qm', 'seed');

    const queued = daemon.gitSnapshot(project);

    fs.writeFileSync(path.join(sibling, 'app.js'), 'two\n');
    repo.git('add', '-A', '.');
    repo.git('commit', '-qm', 'sibling checkpoint');

    const atStart = daemon.gitSnapshot(project);

    assert.equal(queued.head, atStart.head);
    assert.equal(daemon.sameProjectTree(queued, atStart), true);
    assert.equal(daemon.madeNoChanges(queued, atStart), true);
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('a commit inside the project advances its revision', (t) => {
  const repo = tempRepo();

  if (!repo) {
    t.skip('git unavailable');
    return;
  }

  try {
    const project = path.join(repo.dir, 'project');

    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'app.js'), 'one\n');
    repo.git('add', '-A', '.');
    repo.git('commit', '-qm', 'seed');

    const before = daemon.gitSnapshot(project);

    fs.writeFileSync(path.join(project, 'app.js'), 'two\n');
    repo.git('add', '-A', '.');
    repo.git('commit', '-qm', 'worker commit');

    const after = daemon.gitSnapshot(project);

    assert.notEqual(before.head, after.head);
    assert.equal(daemon.madeNoChanges(before, after), false);
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('a worker commit becomes the checkpoint sha only over a clean tree', () => {
  assert.equal(daemon.workerCommitSha('aaa', 'bbb', ''), 'bbb');
  assert.equal(daemon.workerCommitSha('aaa', 'aaa', ''), null);
  assert.equal(daemon.workerCommitSha('aaa', 'bbb', ' M src/app.js'), null);
  assert.equal(daemon.workerCommitSha('', 'bbb', ''), null);
});

test('a continued checkpoint carries the cycle task, not the done count', () => {
  assert.equal(daemon.cycleTaskNumber({ n: 4, task: 3 }, 2), 3);
  assert.equal(daemon.cycleTaskNumber({ n: 4 }, 2), 2);
  assert.equal(daemon.cycleTaskNumber(null, 2), 2);
});

test('a checkpoint only adopts a commit that touched the project', () => {
  assert.match(daemonSource, /'rev-list', '-1', 'HEAD', '--', '\.'/);
  assert.match(daemonSource, /workerCommitSha\(headAtStart, projectHead\(loop\.projectPath\), tree\.output\)/);
});

test('a queued loop revalidates its tree before the first checkpoint', () => {
  assert.match(daemonSource, /sameProjectTree\(loop\.gitAtQueue, gitSnapshot\(loop\.projectPath\)\)/);
  assert.match(daemonSource, /'dirty_project_tree'/);
});

test('the start gate reads the tree, not the revision', () => {
  const queued = { head: 'aaa', tree: '', dirty: 'empty' };

  assert.equal(daemon.sameProjectTree(queued, { head: 'bbb', tree: '', dirty: 'empty' }), true);
  assert.equal(daemon.sameProjectTree(queued, { head: 'aaa', tree: ' M src/app.js', dirty: 'empty' }), false);
  assert.equal(daemon.sameProjectTree(queued, { head: 'aaa', tree: '', dirty: 'other' }), false);
  assert.equal(daemon.sameProjectTree(queued, null), false);
  assert.equal(daemon.sameProjectTree(null, queued), false);
});

test('a missing git snapshot never counts as no progress', () => {
  assert.equal(daemon.madeNoChanges(null, { head: 'aaa', tree: '' }), false);
  assert.equal(daemon.madeNoChanges({ head: 'aaa', tree: '' }, null), false);
  assert.equal(daemon.madeNoChanges(undefined, undefined), false);
});

test('checkpoint commits are restricted to the project path', () => {
  assert.match(daemonSource, /'commit', '-m', value, '--', '\.'/);
});

test('both polish endings checkpoint the validated tree', () => {
  assert.match(daemonSource, /recordCheckpoint\(shipped, null, 'wip\(loop\): polish shipped'\)/);
  assert.match(daemonSource, /recordCheckpoint\(improved, null, 'wip\(loop\): polish improved'\)/);
});

test('a legacy config model is never stamped onto a new loop', () => {
  assert.doesNotMatch(daemonSource, /model: store\.config\.model/);
});

test('checkpointCommit throws GitCheckpointError on git failure', () => {
  const repo = tempRepo();
  assert.ok(repo);
  try {
    fs.writeFileSync(path.join(repo.dir, 'test.txt'), 'initial\n');
    repo.git('add', 'test.txt');
    repo.git('commit', '-m', 'initial commit');

    const loop = { id: 'test-loop', projectPath: repo.dir, autoCommit: true };
    fs.writeFileSync(path.join(repo.dir, '.git', 'index.lock'), '');

    assert.throws(
      () => daemon.checkpointCommit(loop, 'test checkpoint', ''),
      daemon.GitCheckpointError,
    );
  } finally {
    try { fs.unlinkSync(path.join(repo.dir, '.git', 'index.lock')); } catch {}
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('finishLoopCritic fails the cycle and spends retry when checkpoint commit fails', () => {
  store.ensureDirs();
  const repo = tempRepo();
  assert.ok(repo);
  const loopId = 'test-checkpoint-fail-loop';
  try {
    fs.writeFileSync(path.join(repo.dir, 'test.txt'), 'initial\n');
    repo.git('add', 'test.txt');
    repo.git('commit', '-m', 'initial commit');

    const head = repo.git('rev-parse', 'HEAD').stdout.trim();
    const loop = {
      id: loopId,
      type: 'loop',
      status: 'running',
      autoCommit: true,
      projectPath: repo.dir,
      planTasks: ['task one', 'task two'],
      maxCycles: 3,
      taskRetries: 3,
      failStreak: 0,
      cycles: [
        {
          n: 1,
          task: 1,
          status: 'running',
          phase: 'critic',
          gitAtStart: { head },
        },
      ],
    };

    store.writeTask(loop, 'running');
    fs.writeFileSync(path.join(repo.dir, 'test.txt'), 'modified\n');
    fs.writeFileSync(path.join(repo.dir, '.git', 'index.lock'), '');

    daemon.finishLoopCritic(loop, 1, {
      exitCode: 0,
      resultText: 'VERDICT: CONTINUE - done: task one; next: task two',
    });

    const updated = store.readTask(loopId, 'running');
    assert.ok(updated);
    assert.equal(updated.failStreak, 1);
    assert.equal(updated.done, undefined);
    const c1 = updated.cycles[0];
    assert.equal(c1.status, 'failed');
    assert.equal(c1.verdict, 'FAIL');
    assert.match(c1.reason, /index\.lock|checkpoint failed/i);
  } finally {
    try { fs.unlinkSync(path.join(repo.dir, '.git', 'index.lock')); } catch {}
    fs.rmSync(repo.dir, { recursive: true, force: true });
    try { fs.unlinkSync(path.join(store.paths.running, `${loopId}.json`)); } catch {}
  }
});

test('finishLoopWorker retries on worker failure reasons instead of ending loop', () => {
  store.ensureDirs();
  const loopId = 'test-worker-fail-loop';
  const loop = {
    id: loopId,
    type: 'loop',
    status: 'running',
    autoCommit: false,
    planTasks: ['task one'],
    maxCycles: 3,
    taskRetries: 3,
    failStreak: 0,
    cycles: [
      {
        n: 1,
        task: 1,
        status: 'running',
        phase: 'worker',
      },
    ],
  };

  try {
    store.writeTask(loop, 'running');

    daemon.finishLoopWorker(loop, 1, {
      resultText: 'failed without json',
      timedOut: true,
    });

    const updated = store.readTask(loopId, 'running');
    assert.ok(updated);
    assert.equal(updated.status, 'running');
    assert.equal(updated.failStreak, 1);
    const c1 = updated.cycles[0];
    assert.equal(c1.status, 'failed');
    assert.equal(c1.reason, 'timed_out');
  } finally {
    try { fs.unlinkSync(path.join(store.paths.running, `${loopId}.json`)); } catch {}
  }
});

test('stop() marks running loop terminal with daemon_shutdown and logs dirty files', async () => {
  const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-state-'));
  const originalPaths = { ...store.paths };
  Object.assign(store.paths, {
    state: tempStateDir,
    tasks: path.join(tempStateDir, 'tasks'),
    pending: path.join(tempStateDir, 'tasks', 'pending'),
    running: path.join(tempStateDir, 'tasks', 'running'),
    done: path.join(tempStateDir, 'tasks', 'done'),
    results: path.join(tempStateDir, 'results'),
    logs: path.join(tempStateDir, 'logs'),
    events: path.join(tempStateDir, 'events.ndjson'),
    messages: path.join(tempStateDir, 'messages.ndjson'),
    daemon: path.join(tempStateDir, 'daemon.json'),
    bridge: path.join(tempStateDir, 'bridge.json'),
    mcpToken: path.join(tempStateDir, 'mcp-token'),
  });

  store.ensureDirs();
  const repo = tempRepo();
  assert.ok(repo);
  const loopId = 'test-shutdown-loop';
  try {
    fs.writeFileSync(path.join(repo.dir, 'file.txt'), 'initial\n');
    repo.git('add', 'file.txt');
    repo.git('commit', '-m', 'initial');

    fs.writeFileSync(path.join(repo.dir, 'file.txt'), 'dirty content\n');

    const loop = {
      id: loopId,
      type: 'loop',
      status: 'running',
      autoCommit: true,
      projectPath: repo.dir,
      planTasks: ['task one'],
      maxCycles: 3,
      cycles: [
        {
          n: 1,
          task: 1,
          status: 'running',
          phase: 'worker',
        },
      ],
    };

    store.writeTask(loop, 'running');
    fs.writeFileSync(store.paths.daemon, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    assert.equal(fs.existsSync(store.paths.daemon), true);

    daemon.resetStopping();
    let exitedCode = null;
    await daemon.stop((code) => {
      exitedCode = code;
    });

    assert.equal(exitedCode, 0);
    assert.equal(fs.existsSync(store.paths.daemon), false);
    assert.equal(fs.existsSync(path.join(store.paths.running, `${loopId}.json`)), false);

    const doneTask = store.readTask(loopId, 'done');
    assert.ok(doneTask);
    assert.equal(doneTask.status, 'failed');
    assert.equal(doneTask.reason, 'daemon_shutdown');
    assert.ok(Array.isArray(doneTask.dirtyFiles));
    assert.ok(doneTask.dirtyFiles.some((f) => f.includes('file.txt')));
    assert.equal(doneTask.cycles[0].status, 'failed');
    assert.equal(doneTask.cycles[0].reason, 'daemon_shutdown');
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
    Object.assign(store.paths, originalPaths);
    fs.rmSync(tempStateDir, { recursive: true, force: true });
    daemon.resetStopping();
  }
});

test('finishLoop callbacks after stop() has begun return without throwing', async () => {
  const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-state-'));
  const originalPaths = { ...store.paths };
  Object.assign(store.paths, {
    state: tempStateDir,
    tasks: path.join(tempStateDir, 'tasks'),
    pending: path.join(tempStateDir, 'tasks', 'pending'),
    running: path.join(tempStateDir, 'tasks', 'running'),
    done: path.join(tempStateDir, 'tasks', 'done'),
    results: path.join(tempStateDir, 'results'),
    logs: path.join(tempStateDir, 'logs'),
    events: path.join(tempStateDir, 'events.ndjson'),
    messages: path.join(tempStateDir, 'messages.ndjson'),
    daemon: path.join(tempStateDir, 'daemon.json'),
    bridge: path.join(tempStateDir, 'bridge.json'),
    mcpToken: path.join(tempStateDir, 'mcp-token'),
  });

  store.ensureDirs();
  const loopId = 'test-stopping-callback-loop';
  const loop = {
    id: loopId,
    type: 'loop',
    status: 'running',
    autoCommit: false,
    planTasks: ['task one'],
    maxCycles: 3,
    taskRetries: 3,
    failStreak: 0,
    cycles: [
      {
        n: 1,
        task: 1,
        status: 'running',
        phase: 'worker',
      },
    ],
  };

  try {
    store.writeTask(loop, 'running');
    fs.writeFileSync(store.paths.daemon, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));

    daemon.resetStopping();
    await daemon.stop(() => {});

    assert.doesNotThrow(() => {
      daemon.finishLoopWorker(loop, 1, { resultText: 'still running', timedOut: true });
    });
    assert.doesNotThrow(() => {
      daemon.finishLoopCritic(loop, 1, { exitCode: 0, resultText: 'VERDICT: PASS' });
    });

    const doneTask = store.readTask(loopId, 'done');
    assert.ok(doneTask);
    assert.equal(doneTask.status, 'failed');
    assert.equal(doneTask.reason, 'daemon_shutdown');

    const leftoverId = 'test-stopping-leftover-loop';
    const leftover = { ...loop, id: leftoverId };
    store.writeTask(leftover, 'running');

    assert.doesNotThrow(() => {
      daemon.finishLoopWorker(leftover, 1, { resultText: 'still running', timedOut: true });
    });
    assert.doesNotThrow(() => {
      daemon.finishLoopCritic(leftover, 1, { exitCode: 0, resultText: 'VERDICT: PASS' });
    });

    const leftoverTask = store.readTask(leftoverId, 'running');
    assert.ok(leftoverTask);
    assert.equal(leftoverTask.status, 'running');
    assert.equal(leftoverTask.failStreak, 0);
    assert.equal(leftoverTask.cycles[0].status, 'running');
  } finally {
    Object.assign(store.paths, originalPaths);
    fs.rmSync(tempStateDir, { recursive: true, force: true });
    daemon.resetStopping();
  }
});

test('finishLoopCritic fails the cycle, leaves verdict FAIL, and does not latch hasPassedCycle when final-pass checkpoint fails', () => {
  store.ensureDirs();
  const repo = tempRepo();
  assert.ok(repo);
  const loopId = 'test-pass-checkpoint-fail-loop';
  try {
    fs.writeFileSync(path.join(repo.dir, 'test.txt'), 'clean\n');
    repo.git('add', 'test.txt');
    repo.git('commit', '-m', 'clean');
    const head = repo.git('rev-parse', 'HEAD').stdout.trim();

    const loop = {
      id: loopId,
      type: 'loop',
      status: 'running',
      autoCommit: true,
      projectPath: repo.dir,
      planTasks: ['task one'],
      maxCycles: 3,
      taskRetries: 3,
      failStreak: 0,
      cycles: [
        {
          n: 1,
          task: 1,
          status: 'running',
          phase: 'critic',
          gitAtStart: { head },
        },
      ],
    };

    store.writeTask(loop, 'running');
    fs.writeFileSync(path.join(repo.dir, 'test.txt'), 'modified\n');
    fs.writeFileSync(path.join(repo.dir, '.git', 'index.lock'), '');

    daemon.finishLoopCritic(loop, 1, {
      exitCode: 0,
      resultText: 'VERDICT: PASS',
    });

    const updated = store.readTask(loopId, 'running');
    assert.ok(updated);
    assert.equal(updated.failStreak, 1);
    assert.equal(updated.status, 'running');
    const c1 = updated.cycles[0];
    assert.equal(c1.status, 'failed');
    assert.equal(c1.verdict, 'FAIL');
    assert.notEqual(c1.verdict, 'PASS');
    assert.equal(daemon.hasPassedCycle(updated), false);
    assert.match(c1.reason, /index\.lock|checkpoint failed/i);
  } finally {
    try { fs.unlinkSync(path.join(repo.dir, '.git', 'index.lock')); } catch {}
    fs.rmSync(repo.dir, { recursive: true, force: true });
    try { fs.unlinkSync(path.join(store.paths.running, `${loopId}.json`)); } catch {}
  }
});

test('finishLoopCritic fails the cycle, leaves verdict FAIL, and does not complete the loop when polish SHIP checkpoint fails', () => {
  store.ensureDirs();
  const repo = tempRepo();
  assert.ok(repo);
  const loopId = 'test-polish-ship-checkpoint-fail-loop';
  try {
    fs.writeFileSync(path.join(repo.dir, 'test.txt'), 'clean\n');
    repo.git('add', 'test.txt');
    repo.git('commit', '-m', 'clean');
    const head = repo.git('rev-parse', 'HEAD').stdout.trim();

    const loop = {
      id: loopId,
      type: 'loop',
      status: 'running',
      autoCommit: true,
      polish: true,
      projectPath: repo.dir,
      planTasks: ['task one'],
      maxCycles: 3,
      taskRetries: 3,
      failStreak: 0,
      cycles: [
        {
          n: 1,
          status: 'passed',
          phase: 'critic',
          verdict: 'PASS',
        },
        {
          n: 2,
          status: 'running',
          phase: 'polish',
          gitAtStart: { head },
        },
      ],
    };

    store.writeTask(loop, 'running');
    fs.writeFileSync(path.join(repo.dir, 'test.txt'), 'modified\n');
    fs.writeFileSync(path.join(repo.dir, '.git', 'index.lock'), '');

    daemon.finishLoopCritic(loop, 2, {
      exitCode: 0,
      resultText: 'VERDICT: SHIP',
    });

    const updated = store.readTask(loopId, 'running');
    assert.ok(updated);
    assert.equal(updated.failStreak, 1);
    assert.equal(updated.status, 'running');
    assert.notEqual(updated.reason, 'cycle_transition_failed');
    const c2 = updated.cycles[1];
    assert.equal(c2.status, 'failed');
    assert.equal(c2.verdict, 'FAIL');
    assert.notEqual(c2.verdict, 'SHIP');
    assert.notEqual(c2.reason, 'cycle_transition_failed');
    assert.match(c2.reason, /index\.lock|checkpoint failed/i);
  } finally {
    try { fs.unlinkSync(path.join(repo.dir, '.git', 'index.lock')); } catch {}
    fs.rmSync(repo.dir, { recursive: true, force: true });
    try { fs.unlinkSync(path.join(store.paths.running, `${loopId}.json`)); } catch {}
    try { fs.unlinkSync(path.join(store.paths.done, `${loopId}.json`)); } catch {}
  }
});

test('registerFailedCycle records checkpoint error into cycle checkpointError and emits checkpoint_failed event when blocked checkpoint fails', () => {
  store.ensureDirs();
  const repo = tempRepo();
  assert.ok(repo);
  const loopId = 'test-blocked-checkpoint-fail-loop';
  try {
    fs.writeFileSync(path.join(repo.dir, 'test.txt'), 'clean\n');
    repo.git('add', 'test.txt');
    repo.git('commit', '-m', 'clean');
    const head = repo.git('rev-parse', 'HEAD').stdout.trim();

    const loop = {
      id: loopId,
      type: 'loop',
      status: 'running',
      autoCommit: true,
      projectPath: repo.dir,
      planTasks: ['task one', 'task two'],
      maxCycles: 5,
      taskRetries: 1,
      failStreak: 0,
      cycles: [
        {
          n: 1,
          task: 1,
          status: 'running',
          phase: 'critic',
          gitAtStart: { head },
        },
      ],
    };

    store.writeTask(loop, 'running');
    fs.writeFileSync(path.join(repo.dir, 'test.txt'), 'modified\n');
    fs.writeFileSync(path.join(repo.dir, '.git', 'index.lock'), '');

    daemon.registerFailedCycle(loop, 1, {
      status: 'failed',
      phase: 'critic',
      verdict: 'FAIL',
      reason: 'critic_invalid_verdict',
      summary: 'Task 1 failed',
    }, {
      type: 'critic_verdict',
      data: { id: loopId, cycle: 1, verdict: 'FAIL' },
    });

    const updated = store.readTask(loopId, 'running');
    assert.ok(updated);
    assert.ok(Array.isArray(updated.blocked));
    assert.equal(updated.blocked.length, 1);
    const c1 = updated.cycles[0];
    assert.equal(c1.status, 'blocked');
    assert.equal(c1.reason, 'critic_invalid_verdict');
    assert.match(c1.checkpointError, /index\.lock|checkpoint failed/i);
  } finally {
    try { fs.unlinkSync(path.join(repo.dir, '.git', 'index.lock')); } catch {}
    fs.rmSync(repo.dir, { recursive: true, force: true });
    try { fs.unlinkSync(path.join(store.paths.running, `${loopId}.json`)); } catch {}
  }
});


