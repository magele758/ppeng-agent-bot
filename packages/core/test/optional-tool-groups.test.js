import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterToolsByOptionalGroups,
  resolveOptionalToolGroups,
  optionalToolNamesFromGroups,
  loadOptionalToolGroupsFromEnv,
  parseDefaultEnabledOptionalGroups,
  mergeEnabledOptionalToolGroups
} from '../dist/tools/optional-tool-groups.js';

const sampleGroups = loadOptionalToolGroupsFromEnv({});

test('filterToolsByOptionalGroups keeps non-optional always', () => {
  const tools = [{ name: 'read_file' }, { name: 'bash' }];
  const { tools: out } = filterToolsByOptionalGroups(tools, [], sampleGroups);
  assert.deepEqual(
    out.map((t) => t.name),
    ['read_file']
  );
});

test('filterToolsByOptionalGroups enables optional when group selected', () => {
  const tools = [{ name: 'read_file' }, { name: 'bash' }];
  const { tools: out, resolved } = filterToolsByOptionalGroups(tools, ['shell'], sampleGroups);
  assert.deepEqual(resolved.enabledGroups, ['shell']);
  assert.ok(out.some((t) => t.name === 'bash'));
});

test('resolveOptionalToolGroups reports unknown groups', () => {
  const r = resolveOptionalToolGroups(['shell', 'nope'], sampleGroups);
  assert.ok(r.enabledGroups.includes('shell'));
  assert.ok(r.unknownGroups.includes('nope'));
});

test('optionalToolNamesFromGroups covers configured tools', () => {
  const s = optionalToolNamesFromGroups(sampleGroups);
  assert.ok(s.has('bash'));
  assert.ok(s.has('web_fetch'));
  assert.ok(s.has('browser_navigate'));
  assert.ok(s.has('browser_screenshot'));
  assert.ok(s.has('cron_create'));
});

test('parseDefaultEnabledOptionalGroups: comma-separated + trim + dedupe', () => {
  assert.deepEqual(parseDefaultEnabledOptionalGroups({}), []);
  assert.deepEqual(
    parseDefaultEnabledOptionalGroups({ RAW_AGENT_DEFAULT_ENABLED_OPTIONAL_GROUPS: ' shell, network ,shell ' }),
    ['shell', 'network']
  );
});

test('mergeEnabledOptionalToolGroups: server ∪ client', () => {
  assert.deepEqual(mergeEnabledOptionalToolGroups(['shell'], ['network', 'shell']), [
    'shell',
    'network'
  ]);
  assert.deepEqual(mergeEnabledOptionalToolGroups(['shell'], []), ['shell']);
  assert.deepEqual(mergeEnabledOptionalToolGroups([], ['network']), ['network']);
  assert.deepEqual(mergeEnabledOptionalToolGroups(undefined, null), []);
});

test('filterToolsByOptionalGroups with merged defaults enables shell', () => {
  const tools = [{ name: 'read_file' }, { name: 'bash' }, { name: 'web_fetch' }];
  const enabled = mergeEnabledOptionalToolGroups(['shell'], []);
  const { tools: out } = filterToolsByOptionalGroups(tools, enabled, sampleGroups);
  assert.ok(out.some((t) => t.name === 'bash'));
  assert.ok(!out.some((t) => t.name === 'web_fetch'));
  assert.ok(out.some((t) => t.name === 'read_file'));
});
