const test = require('node:test');
const assert = require('node:assert/strict');
const { startDaemon, stopDaemon, runScenario, cleanWorkspace } = require('./runner');

let daemon;

test.before(async () => {
  cleanWorkspace();
  daemon = await startDaemon();
});

test.after(async () => {
  try {
    stopDaemon(daemon);
  } finally {
    cleanWorkspace();
  }
});

// Single-task plan: worker writes add.js, critic returns PASS on cycle 1.
test('scenario: clean-pass completes and checkpoints', async () => {
  const { actual, expect } = await runScenario('clean-pass', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
  for (const snippet of expect.gitMessages || []) {
    assert.ok(actual.gitLog.includes(snippet), `git log missing ${snippet}`);
  }
});

// Multi-task plan: walks 3 tasks with CONTINUE, CONTINUE, PASS and checkpoints each task.
test('scenario: multi-task plan walk checkpoints each task', async () => {
  const { actual, expect } = await runScenario('plan-walk', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
  for (const snippet of expect.gitMessages || []) {
    assert.ok(actual.gitLog.includes(snippet), `git log missing ${snippet}`);
  }
});

// Task failure recovery: cycle 1 fails, cycle 2 succeeds within retry budget.
test('scenario: task retry within budget succeeds', async () => {
  const { actual, expect } = await runScenario('task-retry', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
  for (const snippet of expect.gitMessages || []) {
    assert.ok(actual.gitLog.includes(snippet), `git log missing ${snippet}`);
  }
});

// Cycle budget limit: consecutive failures exhaust maxCycles and resolve to maxed without PASS.
test('scenario: budget exhaustion marks loop maxed', async () => {
  const { actual, expect } = await runScenario('budget-exhaustion', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
});

// Invalid critic verdict retries on task budget then passes on cycle 2.
test('scenario: invalid critic verdict retries on task budget then passes', async () => {
  const { actual, expect } = await runScenario('invalid-critic', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
  for (const snippet of expect.gitMessages || []) {
    assert.ok(actual.gitLog.includes(snippet), `git log missing ${snippet}`);
  }
});

// No-change worker is graded by critic and passes.
test('scenario: no-change worker is graded by critic and passes', async () => {
  const { actual, expect } = await runScenario('no-change-worker', daemon);
  assert.equal(actual.status, expect.status);
  assert.equal(actual.checkpoints, expect.checkpoints);
  assert.equal(actual.tasksDone, expect.tasksDone);
  assert.deepEqual(actual.verdicts, expect.verdicts);
  assert.equal(actual.daemonAlive, true);
  for (const snippet of expect.gitMessages || []) {
    assert.ok(actual.gitLog.includes(snippet), `git log missing ${snippet}`);
  }
});

