const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const daemon = require('../src/daemon');

const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.js'), 'utf8');

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

test('a missing git snapshot never counts as no progress', () => {
  assert.equal(daemon.madeNoChanges(null, { head: 'aaa', tree: '' }), false);
  assert.equal(daemon.madeNoChanges({ head: 'aaa', tree: '' }, null), false);
  assert.equal(daemon.madeNoChanges(undefined, undefined), false);
});

test('checkpoint commits are restricted to the project path', () => {
  assert.match(daemonSource, /'commit', '-m', value, '--', '\.'/);
});

test('a legacy config model is never stamped onto a new loop', () => {
  assert.doesNotMatch(daemonSource, /model: store\.config\.model/);
});
