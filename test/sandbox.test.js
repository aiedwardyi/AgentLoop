const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.js'), 'utf8');
const sandboxArgs = [
  "'--sandbox', 'workspace-write'",
  "'approval_policy=\"on-request\"'",
  "'approvals_reviewer=\"auto_review\"'",
  "'sandbox_workspace_write.network_access=false'",
];

function getSessionArgs(functionName) {
  const functionStart = daemonSource.indexOf(`function ${functionName}(`);
  const functionEnd = daemonSource.indexOf('\nfunction ', functionStart + 1);
  const argsStart = daemonSource.indexOf('  const args = [', functionStart);
  const argsEnd = daemonSource.indexOf('\n  ];', argsStart);

  assert.notEqual(functionStart, -1);
  assert.ok(argsStart > functionStart);
  assert.ok(argsEnd > argsStart);
  assert.ok(functionEnd === -1 || argsEnd < functionEnd);
  return daemonSource.slice(argsStart, argsEnd);
}

test('Codex sessions use workspace sandboxing', () => {
  assert.doesNotMatch(daemonSource, /--dangerously-bypass-approvals-and-sandbox/);

  for (const functionName of ['spawnLoopSession', 'spawnWorker']) {
    const args = getSessionArgs(functionName);

    for (const expectedArg of sandboxArgs) {
      assert.ok(args.includes(expectedArg), `${functionName} is missing ${expectedArg}`);
    }
  }
});
