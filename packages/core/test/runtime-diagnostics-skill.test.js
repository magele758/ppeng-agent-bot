import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadWorkspaceSkills } from '../dist/skills/skill-registry.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
test('项目 Agent 可加载故障诊断指南 [AC:runtime-diagnostics-skill#AC-1]', async () => {
  const skill = (await loadWorkspaceSkills(root)).find(s => s.name === 'agent-home-diagnostics');
  assert.equal(skill?.source, 'workspace');
  for (const term of ['session_messages','omittedEarlier','test:acceptance']) assert.ok(skill.content.includes(term));
});

test('提取安全且可追溯的时间线 [AC:runtime-diagnostics-skill#AC-2]', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-trace-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const file = join(dir, 'events.jsonl');
  const event = kind => JSON.stringify({ts:'2026-01-02T00:00:00.000Z',sessionId:'session_a',kind,payload:{text:'PRIVATE',requestId:'PRIVATE',turnIndex:4}});
  writeFileSync(file, [event('turn_end'),'{PRIVATE',event('turn_start')].join('\n'));
  const output = execFileSync(process.execPath, [join(root,'skills/agent-home-diagnostics/timeline.mjs'),file],{encoding:'utf8'});
  assert.doesNotMatch(output,/PRIVATE/);
  const rows = output.trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(rows.map(r=>[r.line,r.kind]),[[1,'turn_end'],[2,'invalid_record'],[3,'turn_start']]);
});
