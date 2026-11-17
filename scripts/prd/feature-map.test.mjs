import { readFileSync } from "node:fs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { loadCoreCases } from './core-cases-plan.mjs';
import { fileURLToPath } from 'node:url';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
import { findJourneys, validateLocations } from './feature-map-model.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('按用户叫法定位到实际代码、验收和两种验证 [AC:agent-feature-map#AC-1]', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/prd/feature-map.mjs', '--json', '串线'], { cwd: root, env: sanitizeScriptEnv() }));
  assert.equal(result.filter(row => row.kind === 'journey').length, 1);
  const { cases } = loadCoreCases(root);
  assert.equal(findJourneys(cases, '左侧边栏里的 Bot 切换后消息串线')[0].id, 'bot-switch');
  assert.deepEqual(findJourneys(cases, '不会出现的路径'), []);
  const [feature] = result;
  assert.equal(feature.route, '#/bot');
  assert.ok(feature.sources.includes('apps/web-console/components/usePlayChat.ts'));
  assert.ok(feature.acceptance.includes('acceptance/bot-switch-live-turn.yaml'));
  assert.ok(feature.tests.includes('e2e/bot-switch-live-turn.spec.ts'));
  assert.equal(feature.regression, 'node scripts/prd/core-cases.mjs --case bot-switch');
  assert.equal(feature.exploration, null);
});

test('校验真实地图并拒绝失效入口 [AC:agent-feature-map#AC-2]', () => {
  const { cases } = loadCoreCases(root);
  validateLocations(root, cases);
  const entry = cases[0];
  for (const patch of [{ route: '#/bot/typo' }, { sources: ['apps/does-not-exist.ts'] }, { exploration: 'test:missing' }]) {
    assert.throws(() => validateLocations(root, [{ ...entry, ...patch }]), new RegExp(entry.id));
  }
});

test('全量规格保留状态、测试、章节与独立产品文档入口 [AC:agent-feature-map#AC-3]', () => {
  const query = (...args) => execFileSync(process.execPath, ['scripts/prd/feature-map.mjs', ...args], { cwd: root, env: sanitizeScriptEnv(), encoding: 'utf8' });
  const catalog = JSON.parse(readFileSync(root + 'doc/prd/catalog.json', 'utf8'));
  const all = JSON.parse(query('--json'));
  const specs = all.filter(entry => entry.kind === 'spec');
  assert.deepEqual(specs.map(row => [row.id, row.status]).sort(), [
    ...catalog.shipped.map(row => [row.id, 'implemented']),
    ...catalog.pending.map(row => [row.id, row.status]),
    ...catalog.retired.map(row => [row.id, 'retired'])
  ].sort());
  const [feature] = JSON.parse(query('--json', 'acceptance-gate'));
  assert.ok(feature.tests.includes('scripts/test/acceptance-lib.test.mjs'));
  const trace = JSON.parse(readFileSync(root + 'doc/prd/trace.json', 'utf8'));
  for (const chapter of trace.chapters) {
    assert.ok(all.some(row => row.kind === 'document' && row.path === chapter.file));
    for (const row of chapter.specs) assert.ok(specs.find(entry => entry.id === row.id).chapters.includes(chapter.file));
  }
  assert.ok(all.some(row => row.path === 'doc/prd/backlog/sidechat/PRD.md'));
  assert.match(query(), /doc\/bot\/00-functional-guide.md/);
});
