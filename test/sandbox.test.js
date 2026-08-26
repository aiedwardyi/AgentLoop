const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engines = require('../src/engines');

const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.js'), 'utf8');
const engineSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'engines.js'), 'utf8');

function argsFor(id) {
  const engine = engines.get(id);
  return engine.args({ model: 'test-model', outputPath: 'out.tmp' });
}

function pairFollowing(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test('no engine bypasses its approval layer', () => {
  for (const source of [daemonSource, engineSource]) {
    assert.doesNotMatch(source, /--dangerously-bypass-approvals-and-sandbox/);
    assert.doesNotMatch(source, /--dangerously-skip-permissions/);
  }
});

test('Codex sessions use workspace sandboxing', () => {
  const args = argsFor('codex');

  assert.equal(pairFollowing(args, '--sandbox'), 'workspace-write');
  assert.ok(args.includes('approval_policy="on-request"'));
  assert.ok(args.includes('approvals_reviewer="auto_review"'));
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
});

test('Claude sessions accept edits without inheriting operator config', () => {
  const args = argsFor('claude');

  assert.equal(pairFollowing(args, '--permission-mode'), 'acceptEdits');
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(pairFollowing(args, '--disallowedTools'), 'WebFetch,WebSearch');
});

test('Claude workers do not inherit a parent Claude Code session', () => {
  const env = engines.get('claude').env({ PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '9' });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal('CLAUDECODE' in env, false);
  assert.equal('CLAUDE_CODE_ENTRYPOINT' in env, false);
  assert.equal('CLAUDE_CODE_SSE_PORT' in env, false);
});

test('every engine passes the selected model through', () => {
  for (const id of engines.ids()) {
    assert.equal(pairFollowing(argsFor(id), '--model'), 'test-model', `${id} drops the model`);
  }
});
