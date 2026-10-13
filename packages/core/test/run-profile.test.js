import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRunProfileToTools,
  applyUnboundTaskModePatch,
  BROWSER_TOOLS,
  COMPUTER_USE_TOOLS,
  FAST_MODE_TOOL_ALLOWLIST,
  filterSkillsByScope,
  parseTaskMode,
  PLAN_PROTOCOL_TOOLS,
  RESEARCH_TOOLS,
  resolveRunProfile,
  sealTaskRunModePatch,
  TASK_MODES,
  TEAMS_TOOLS,
  visibleToolNames
} from '../dist/runtime/run-profile.js';

const ASSEMBLED = [
  'read_file',
  'write_file',
  'bash',
  'grep_files',
  'memory_set',
  'memory_get',
  'submit_plan',
  'request_confirmation',
  'confirm_plan',
  'start_step',
  'complete_step',
  'fail_step',
  'spawn_subagent',
  'spawn_teammate',
  'list_team',
  'send_message',
  'read_inbox',
  'web_search',
  'web_fetch',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'ptc_exec',
  'load_skill',
  'search_skills'
];

function names(mode, extra = {}) {
  return visibleToolNames(
    resolveRunProfile(mode, extra.skillScope, extra.engine, extra.replay),
    ASSEMBLED
  );
}

test('eight TaskModes are distinct and parse standard as auto', () => {
  assert.deepEqual([...TASK_MODES].sort(), [
    'auto',
    'browser',
    'computer',
    'deep_research',
    'dynamic_workflow',
    'fast',
    'planner',
    'teams'
  ]);
  assert.equal(parseTaskMode('standard'), 'auto');
  assert.equal(parseTaskMode('nope'), undefined);
  assert.equal(resolveRunProfile(undefined).mode, 'auto');
});

test('8-mode tool visibility', () => {
  const auto = names('auto');
  assert.ok(auto.includes('spawn_subagent'));
  assert.ok(auto.includes('submit_plan'));
  assert.ok(auto.includes('web_search'));
  assert.ok(auto.includes('browser_navigate'));
  assert.ok(auto.includes('computer_screenshot'));
  assert.ok(!auto.includes('ptc_exec'));

  const fast = names('fast');
  assert.ok(fast.includes('read_file'));
  assert.ok(!fast.includes('submit_plan'));
  assert.ok(!fast.includes('memory_set'));
  assert.ok(!fast.includes('spawn_subagent'));
  assert.ok(!fast.includes('ptc_exec'));
  assert.ok(!fast.includes('browser_navigate'));
  assert.ok(!fast.includes('browser_screenshot'));
  assert.ok(!fast.includes('computer_screenshot'));
  assert.ok(FAST_MODE_TOOL_ALLOWLIST.every((n) => ASSEMBLED.includes(n) ? fast.includes(n) : true));

  const planner = names('planner');
  assert.ok(PLAN_PROTOCOL_TOOLS.every((n) => planner.includes(n)));
  assert.ok(planner.includes('read_file'));
  assert.ok(!planner.includes('write_file'));
  assert.ok(!planner.includes('bash'));
  assert.ok(!planner.includes('spawn_subagent'));
  assert.ok(!planner.includes('ptc_exec'));

  const teams = names('teams');
  assert.ok(TEAMS_TOOLS.every((n) => teams.includes(n)));
  assert.ok(!teams.includes('ptc_exec'));

  const research = names('deep_research');
  assert.ok(RESEARCH_TOOLS.every((n) => research.includes(n)));
  assert.ok(!research.includes('ptc_exec'));
  assert.ok(!research.includes('computer_screenshot'));
  assert.ok(!research.includes('spawn_subagent'));

  const browser = names('browser');
  assert.ok(BROWSER_TOOLS.every((n) => browser.includes(n)));
  assert.ok(!browser.includes('ptc_exec'));
  assert.ok(!browser.includes('computer_screenshot'));

  const computer = names('computer');
  assert.ok(computer.includes('computer_screenshot'));
  assert.ok(computer.includes('computer_click'));
  assert.ok(!computer.includes('ptc_exec'));
  assert.ok(!computer.includes('browser_navigate'));
  assert.ok(!computer.includes('browser_screenshot'));

  const dw = names('dynamic_workflow');
  assert.ok(dw.includes('ptc_exec'));
  assert.ok(!dw.includes('spawn_subagent'));
  assert.ok(!dw.includes('spawn_teammate'));
  assert.ok(!dw.includes('submit_plan'));
});

test('browser/computer force-visible after optional-group hide', () => {
  const hidden = ASSEMBLED.filter((n) => !n.startsWith('browser_') && !n.startsWith('computer_')).map(
    (name) => ({ name })
  );
  const assembled = ASSEMBLED.map((name) => ({ name }));
  const browser = applyRunProfileToTools(hidden, resolveRunProfile('browser'), assembled).map(
    (t) => t.name
  );
  assert.ok(browser.includes('browser_navigate'));
  const computer = applyRunProfileToTools(hidden, resolveRunProfile('computer'), assembled).map(
    (t) => t.name
  );
  assert.ok(computer.includes('computer_screenshot'));
});

test('skill_scope is orthogonal to TaskMode', () => {
  assert.equal(resolveRunProfile('fast', 'full').skillScope, 'full');
  assert.equal(resolveRunProfile('fast', 'requested').skillScope, 'requested');
  assert.equal(resolveRunProfile('auto').skillScope, 'full');
  assert.equal(resolveRunProfile('fast').persistentMemory, 'off');
  assert.equal(resolveRunProfile('fast', 'full').persistentMemory, 'off');
  const skills = [{ name: 'alpha' }, { name: 'beta' }];
  assert.deepEqual(
    filterSkillsByScope(skills, 'requested', ['beta']).map((s) => s.name),
    ['beta']
  );
  assert.deepEqual(
    filterSkillsByScope(skills, 'full', ['beta']).map((s) => s.name),
    ['alpha', 'beta']
  );
});

test('write-once: Lab can switch until first-turn seal', () => {
  const first = applyUnboundTaskModePatch({}, 'fast');
  assert.equal(first.ok, true);
  assert.deepEqual(first.patch, { taskRunMode: 'fast' });

  const again = applyUnboundTaskModePatch({ taskRunMode: 'fast' }, 'planner');
  assert.equal(again.ok, true);
  assert.deepEqual(again.patch, { taskRunMode: 'planner' });

  const sealed = sealTaskRunModePatch({ taskRunMode: 'planner' }, 'planner');
  assert.equal(sealed.taskRunMode, 'planner');
  assert.equal(sealed.taskRunModeBound, true);

  const blocked = applyUnboundTaskModePatch(
    { taskRunMode: 'planner', taskRunModeBound: true },
    'teams'
  );
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.bound, 'planner');

  const same = applyUnboundTaskModePatch(
    { taskRunMode: 'planner', taskRunModeBound: true },
    'planner'
  );
  assert.equal(same.ok, true);
  assert.deepEqual(same.patch, {});
});

test('hard replay denylists ptc_exec and spawn', () => {
  const hard = names('dynamic_workflow', { replay: 'hard' });
  assert.ok(!hard.includes('ptc_exec'));
  assert.ok(!hard.includes('spawn_subagent'));
});
