const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const daemon = require('../src/daemon');

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
