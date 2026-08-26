const test = require('node:test');
const assert = require('node:assert/strict');

const state = require('../src/state');

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

test('absolute paths collapse to their last segment', () => {
  assert.equal(state.stripAbsPaths('Edit: C:\\Users\\someone\\repo\\src\\app.js'), 'Edit: app.js');
  assert.equal(state.stripAbsPaths('ran "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -c x'), 'ran "pwsh.exe" -c x');
  assert.equal(state.stripAbsPaths('read /home/someone/repo/notes.md now'), 'read notes.md now');
  assert.equal(state.stripAbsPaths('~/projects/demo/main.py failed'), 'main.py failed');
  assert.equal(state.stripAbsPaths('copy \\\\server\\share\\file.txt'), 'copy file.txt');
});

test('single-segment absolute paths collapse too', () => {
  assert.equal(state.stripAbsPaths('wrote /etc'), 'wrote etc');
  assert.equal(state.stripAbsPaths('read C:\\boot.ini now'), 'read boot.ini now');
  assert.equal(state.stripAbsPaths('/etc'), 'etc');
});

test('non-path text survives path stripping', () => {
  for (const text of [
    'http://127.0.0.1:5758/mcp?key=abc',
    'https://example.com/a/b/c',
    'examples/calculator walked the plan',
    'grade: A - retry 2/3',
    'wip(loop): task 2 - add tests',
  ]) {
    assert.equal(state.stripAbsPaths(text), text);
  }
});

test('sanitizeState scrubs every string in the payload', () => {
  const value = state.sanitizeState({
    daemon: { pid: 7, alive: true },
    events: [{ text: 'saw C:\\Users\\x\\repo\\file.js', kind: 'info' }],
    nested: { deep: ['ok', '/var/tmp/thing/log.txt'] },
  });

  assert.deepEqual(value, {
    daemon: { pid: 7, alive: true },
    events: [{ text: 'saw file.js', kind: 'info' }],
    nested: { deep: ['ok', 'log.txt'] },
  });
});

test('pending items expose whitelisted fields with basenames only', () => {
  const loop = state.publicPending({
    id: 't-1',
    type: 'loop',
    title: 'loop: C:\\Users\\x\\projects\\demo',
    project: 'C:\\Users\\x\\projects\\demo',
    projectPath: 'C:\\Users\\x\\projects\\demo',
    cwd: 'C:\\Users\\x',
    prompt: 'secret',
    createdAt: '2026-07-28T11:00:00.000Z',
  }, 'claude');

  assert.deepEqual(loop, {
    id: 't-1',
    type: 'loop',
    title: 'loop: demo',
    project: 'demo',
    engine: 'claude',
    createdAt: '2026-07-28T11:00:00.000Z',
  });

  const task = state.publicPending({ id: 't-2', type: 'task', title: 'fix parser', engine: 'codex', createdAt: 'x' }, 'claude');

  assert.equal(task.engine, 'codex');
  assert.equal('project' in task, false);
});

test('running tasks omit activity fields until activity exists', () => {
  const bare = state.publicRunning(
    { id: 't-3', type: 'task', title: 'job', startedAt: '2026-07-28T11:59:00.000Z' },
    undefined,
    'claude',
    NOW,
  );

  assert.equal(bare.elapsedMs, 60000);
  assert.equal('lastActivity' in bare, false);
  assert.equal('toolCalls' in bare, false);
  assert.equal('checkpoints' in bare, false);

  const active = state.publicRunning(
    { id: 't-3', type: 'task', title: 'job', startedAt: '2026-07-28T11:59:00.000Z' },
    { text: 'Edit: app.js', toolCalls: 4 },
    'claude',
    NOW,
  );

  assert.equal(active.lastActivity, 'Edit: app.js');
  assert.equal(active.toolCalls, 4);
});

test('running loops map cycles into the dashboard verdict vocabulary', () => {
  const loop = state.publicRunning({
    id: 't-4',
    type: 'loop',
    project: 'demo',
    projectPath: 'C:\\x\\demo',
    startedAt: '2026-07-28T11:00:00.000Z',
    cycle: 3,
    maxCycles: 6,
    autoCommit: true,
    checkpointShas: [{ task: 1, sha: 'abc1234' }],
    cycles: [
      { n: 1, task: 1, status: 'continue', summary: 'done one', costUsd: 0.4, durationMs: 1000 },
      { n: 2, task: 2, status: 'failed', workerCostUsd: 0.2, durationMs: 900 },
      { n: 3, task: 2, status: 'running' },
    ],
  }, undefined, 'claude', NOW);

  assert.equal(loop.cycle, 3);
  assert.equal(loop.maxCycles, 6);
  assert.equal(loop.checkpoints, 1);
  assert.deepEqual(loop.cycles[0], { n: 1, task: 1, status: 'continue', summary: 'done one', costUsd: 0.4, durationMs: 1000 });
  assert.deepEqual(loop.cycles[1], { n: 2, task: 2, status: 'fail', costUsd: 0.2, durationMs: 900 });
  assert.deepEqual(loop.cycles[2], { n: 3, task: 2, status: 'running' });
  assert.equal('plan' in loop, false);
});

test('polish and ship cycles carry the polish phase and no task tag', () => {
  const loop = state.publicRunning({
    id: 't-5',
    type: 'loop',
    project: 'demo',
    startedAt: '2026-07-28T11:00:00.000Z',
    cycles: [
      { n: 1, task: 1, status: 'passed', verdict: 'PASS', summary: 'plan done' },
      { n: 2, status: 'improve', phase: 'polish', summary: 'tighten copy' },
      { n: 3, task: 9, status: 'passed', verdict: 'SHIP', phase: 'polish' },
    ],
  }, undefined, 'claude', NOW);

  assert.deepEqual(loop.cycles[0], { n: 1, task: 1, status: 'pass', summary: 'plan done' });
  assert.deepEqual(loop.cycles[1], { n: 2, status: 'improve', phase: 'polish', summary: 'tighten copy' });
  assert.deepEqual(loop.cycles[2], { n: 3, status: 'ship', phase: 'polish' });
});

test('plan rail walks cycles into per-task statuses', () => {
  const loop = state.publicRunning({
    id: 't-6',
    type: 'loop',
    project: 'demo',
    startedAt: '2026-07-28T11:00:00.000Z',
    taskRetries: 2,
    failStreak: 0,
    autoCommit: true,
    planTasks: ['build parser', 'wire CLI', 'ship docs', 'tag release'],
    checkpointShas: [{ task: 1, sha: 'aaa1111' }, { task: 3, sha: 'ccc3333' }],
    blocked: [{ task: 2, item: 'wire CLI' }],
    cycles: [
      { n: 1, task: 1, status: 'continue' },
      { n: 2, task: 2, status: 'failed' },
      { n: 3, task: 2, status: 'blocked', fixes: 'retry budget exhausted' },
      { n: 4, task: 3, status: 'continue' },
      { n: 5, task: 4, status: 'running' },
    ],
  }, undefined, 'claude', NOW);

  assert.equal(loop.plan.file, 'PLAN.md');
  assert.equal(loop.plan.rubric, 'GUIDELINES.md');
  assert.deepEqual(loop.plan.tasks, [
    { n: 1, title: 'build parser', status: 'done', tries: 1, budget: 2, checkpoint: 'aaa1111' },
    { n: 2, title: 'wire CLI', status: 'blocked', tries: 2, budget: 2, note: 'retry budget exhausted' },
    { n: 3, title: 'ship docs', status: 'done', tries: 1, budget: 2, checkpoint: 'ccc3333' },
    { n: 4, title: 'tag release', status: 'active', tries: 1, budget: 2 },
  ]);
});

test('a pass completes the remaining plan and fills missing shas from the pass checkpoint', () => {
  const loop = state.publicRunning({
    id: 't-7',
    type: 'loop',
    project: 'demo',
    startedAt: '2026-07-28T11:00:00.000Z',
    taskRetries: 3,
    autoCommit: true,
    planTasks: ['one', 'two', 'three'],
    checkpointShas: [{ task: 1, sha: 'aaa1111' }, { sha: 'fff9999' }],
    cycles: [
      { n: 1, task: 1, status: 'continue' },
      { n: 2, task: 2, status: 'failed' },
      { n: 3, task: 2, status: 'passed', verdict: 'PASS' },
    ],
  }, undefined, 'claude', NOW);

  assert.deepEqual(loop.plan.tasks, [
    { n: 1, title: 'one', status: 'done', tries: 1, budget: 3, checkpoint: 'aaa1111' },
    { n: 2, title: 'two', status: 'done', tries: 2, budget: 3, checkpoint: 'fff9999' },
    { n: 3, title: 'three', status: 'done', tries: 1, budget: 3, checkpoint: 'fff9999' },
  ]);
});

test('recent records whitelist fields and only claim task counts when they exist', () => {
  const passedLoop = state.publicRecent(
    {
      id: 't-8',
      type: 'loop',
      project: 'demo',
      projectPath: 'C:\\x\\demo',
      autoCommit: true,
      checkpointShas: [{ task: 1, sha: 'a' }, { sha: 'b' }],
      done: ['one', 'two'],
      blocked: [{ task: 3, item: 'x' }],
      cycles: [{ n: 1, status: 'continue', costUsd: 0.5 }, { n: 2, status: 'passed', costUsd: 0.25 }],
    },
    { status: 'partial', summary: 'Passed with 1 blocked task.', durationMs: 5000, finishedAt: '2026-07-28T11:30:00.000Z' },
    'claude',
  );

  assert.deepEqual(passedLoop, {
    id: 't-8',
    type: 'loop',
    title: 'loop: demo',
    engine: 'claude',
    status: 'partial',
    summary: 'Passed with 1 blocked task.',
    costUsd: 0.75,
    durationMs: 5000,
    finishedAt: '2026-07-28T11:30:00.000Z',
    tasksDone: 3,
    tasksBlocked: 1,
    checkpoints: 2,
  });

  const codexLoop = state.publicRecent(
    { id: 't-9', type: 'loop', project: 'demo', cycles: [{ n: 1, status: 'passed' }] },
    { status: 'passed', summary: 'Passed.', durationMs: 100, finishedAt: 'x' },
    'codex',
  );

  assert.equal('costUsd' in codexLoop, false);
  assert.equal('tasksDone' in codexLoop, false);
  assert.equal('tasksBlocked' in codexLoop, false);
  assert.equal(codexLoop.checkpoints, false);

  const task = state.publicRecent(
    { id: 't-10', type: 'task', title: 'fix parser' },
    { status: 'done', summary: 'ok', costUsd: 0.12, durationMs: 100, finishedAt: 'x' },
    'claude',
  );

  assert.equal(task.costUsd, 0.12);
  assert.equal('checkpoints' in task, false);
});

test('recent loops count the plan item the pass completed', () => {
  const walked = state.publicRecent(
    {
      id: 't-11',
      type: 'loop',
      project: 'demo',
      planTasks: ['one', 'two', 'three'],
      done: ['one', 'two'],
      cycles: [
        { n: 1, task: 1, status: 'continue' },
        { n: 2, task: 2, status: 'continue' },
        { n: 3, task: 3, status: 'passed', verdict: 'PASS' },
      ],
    },
    { status: 'passed', summary: 'Passed.', durationMs: 10, finishedAt: 'x' },
    'claude',
  );

  assert.equal(walked.tasksDone, 3);

  const single = state.publicRecent(
    {
      id: 't-12',
      type: 'loop',
      project: 'demo',
      planTasks: ['only item'],
      cycles: [{ n: 1, task: 1, status: 'passed', verdict: 'PASS' }],
    },
    { status: 'passed', summary: 'Passed.', durationMs: 10, finishedAt: 'x' },
    'claude',
  );

  assert.equal(single.tasksDone, 1);
});

test('a polish checkpoint does not displace the final-pass sha', () => {
  const loop = state.publicRunning({
    id: 't-13',
    type: 'loop',
    project: 'demo',
    startedAt: '2026-07-28T11:00:00.000Z',
    taskRetries: 3,
    autoCommit: true,
    planTasks: ['one', 'two'],
    checkpointShas: [{ task: 1, sha: 'aaa1111' }, { sha: 'fff9999' }, { sha: 'ppp8888' }],
    cycles: [
      { n: 1, task: 1, status: 'continue' },
      { n: 2, task: 2, status: 'passed', verdict: 'PASS' },
      { n: 3, status: 'passed', verdict: 'SHIP', phase: 'polish' },
    ],
  }, undefined, 'claude', NOW);

  assert.equal(loop.plan.tasks[1].checkpoint, 'fff9999');
  assert.equal(loop.checkpoints, 3);
});

test('cycle cost sums fall back to worker cost and respect the since filter', () => {
  const cycles = [
    { n: 1, costUsd: 0.5, finishedAt: '2026-07-28T01:00:00.000Z' },
    { n: 2, workerCostUsd: 0.25, finishedAt: '2026-07-28T02:00:00.000Z' },
    { n: 3, status: 'running' },
  ];

  assert.equal(state.sumCycleCosts(cycles), 0.75);
  assert.equal(state.sumCycleCosts(cycles, Date.parse('2026-07-28T01:30:00.000Z')), 0.25);
  assert.equal(state.sumCycleCosts([{ n: 1 }]), null);
  assert.equal(state.sumCycleCosts([]), null);
});
