const test = require('node:test');
const assert = require('node:assert/strict');

const tools = require('../src/tools');

test('structuredContent only ever carries a JSON object', () => {
  assert.deepEqual(tools.structuredValue({ delivered: true }), { delivered: true });
  assert.deepEqual(tools.structuredValue([{ id: 'a' }, { id: 'b' }]), { ok: true });
  assert.deepEqual(tools.structuredValue([]), { ok: true });
  assert.deepEqual(tools.structuredValue(null), { ok: true });
  assert.deepEqual(tools.structuredValue('queued'), { ok: true });
});

test('every tool advertises an object input schema', () => {
  for (const tool of tools.tools) {
    assert.equal(tool.inputSchema.type, 'object');
  }
});
