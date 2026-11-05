import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';

const ALLOWED = new Set(['read', 'edit', 'bash', 'network', 'delegate']);

test('every builtin tool has an access class other than other', () => {
  const tools = createBuiltinTools({}) as Array<{ name: string; access?: string }>;
  assert.ok(tools.length > 10);
  for (const tool of tools) {
    assert.ok(ALLOWED.has(tool.access ?? ''), `${tool.name} access=${tool.access}`);
  }
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.access]));
  assert.equal(byName.read_file, 'read');
  assert.equal(byName.edit_file, 'edit');
  assert.equal(byName.bash, 'bash');
  assert.equal(byName.web_fetch, 'network');
  assert.equal(byName.spawn_subagent, 'delegate');
  assert.equal(byName.send_message, 'network');
});
