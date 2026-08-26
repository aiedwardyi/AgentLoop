const test = require('node:test');
const assert = require('node:assert/strict');

const engines = require('../src/engines');

const claude = engines.get('claude');
const codex = engines.get('codex');

test('registry exposes both engines and rejects unknown ones', () => {
  assert.deepEqual(engines.ids().sort(), ['claude', 'codex']);
  assert.equal(engines.has('grok'), false);
  assert.equal(engines.get('grok'), null);
});

test('Claude reports its final message from the result event', () => {
  assert.deepEqual(claude.parseLine('{"type":"result","subtype":"success","result":"all done"}'), {
    text: 'session finished',
    result: 'all done',
  });
});

test('Claude surfaces session cost only when the result event carries one', () => {
  const parsed = claude.parseLine('{"type":"result","subtype":"success","result":"done","total_cost_usd":0.4321}');

  assert.equal(parsed.costUsd, 0.4321);
  assert.equal('costUsd' in claude.parseLine('{"type":"result","result":"done"}'), false);
  assert.equal('costUsd' in claude.parseLine('{"type":"result","result":"done","total_cost_usd":"free"}'), false);
});

test('Claude counts tool blocks and surfaces their target', () => {
  const bash = claude.parseLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}');

  assert.equal(bash.tool, true);
  assert.equal(bash.text, 'Bash: npm test');

  const edit = claude.parseLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/app.js"}}]}}');

  assert.equal(edit.text, 'Edit: src/app.js');
});

test('Claude marks assistant prose as a message, not a tool call', () => {
  const parsed = claude.parseLine('{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"}]}}');

  assert.equal(parsed.text, 'working on it');
  assert.equal(parsed.message, true);
  assert.equal(parsed.tool, undefined);
});

test('Claude ignores thinking blocks and unrelated system events', () => {
  assert.equal(claude.parseLine('{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}').text, '');
  assert.equal(claude.parseLine('{"type":"rate_limit_event"}').text, '');
  assert.equal(claude.parseLine('{"type":"user","message":{"content":[]}}').text, '');
});

test('Codex counts completed tool items', () => {
  const parsed = codex.parseLine('{"type":"item.completed","item":{"type":"command_execution","command":"pytest -q"}}');

  assert.equal(parsed.tool, true);
  assert.equal(parsed.text, 'pytest -q');

  assert.equal(codex.parseLine('{"type":"item.started","item":{"type":"command_execution","command":"pytest -q"}}').tool, false);
});

test('both engines pass non-JSON lines through untouched', () => {
  for (const engine of [claude, codex]) {
    assert.equal(engine.parseLine('plain stderr text').text, 'plain stderr text');
  }
});

test('only Codex needs a final-message file', () => {
  assert.equal(codex.usesOutputFile, true);
  assert.equal(claude.usesOutputFile, false);
});

test('model resolution prefers the task override, then per-engine config, then legacy key', () => {
  assert.equal(engines.modelFor(claude, {}, 'sonnet'), 'sonnet');
  assert.equal(engines.modelFor(claude, { models: { claude: 'haiku' } }), 'haiku');
  assert.equal(engines.modelFor(claude, { model: 'legacy' }), 'legacy');
  assert.equal(engines.modelFor(claude, {}), claude.defaultModel);
});

test('a configured engine path overrides PATH lookup', () => {
  assert.equal(engines.binary(claude, { claude: 'C:\\custom\\claude.exe' }), 'C:\\custom\\claude.exe');
});
