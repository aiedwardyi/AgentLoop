const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.js'), 'utf8');

test('Codex sessions use workspace sandboxing', () => {
  assert.doesNotMatch(daemonSource, /--dangerously-bypass-approvals-and-sandbox/);
  assert.equal((daemonSource.match(/'--sandbox', 'workspace-write'/g) || []).length, 2);
  assert.equal((daemonSource.match(/'approval_policy="on-request"'/g) || []).length, 2);
  assert.equal((daemonSource.match(/'approvals_reviewer="auto_review"'/g) || []).length, 2);
  assert.equal((daemonSource.match(/'sandbox_workspace_write\.network_access=false'/g) || []).length, 2);
});
