import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  agentEvalDefaultOn,
  agentsWithEvalDefaultOn,
  discoverAgentFolders,
  loadAgentFromFolder
} from '../dist/agents/agent-as-folder.js';
import { loadPluginFromDir } from '../dist/plugins/plugin-loader.js';

function writeAgentFolder(root, slug, raw, md) {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(raw, null, 2));
  if (md != null) writeFileSync(join(dir, 'AGENT.md'), md);
  return dir;
}

test('agentEvalDefaultOn is true when eval omitted [AC:agent-as-folder-eval#AC-2]', () => {
  assert.equal(agentEvalDefaultOn({}), true);
  assert.equal(agentEvalDefaultOn(undefined), true);
  assert.equal(agentEvalDefaultOn({ eval: true }), true);
});

test('agentEvalDefaultOn is false only when explicitly disabled [AC:agent-as-folder-eval#AC-3]', () => {
  assert.equal(agentEvalDefaultOn({ eval: false }), false);
  assert.equal(agentEvalDefaultOn({ eval: 0 }), false);
  assert.equal(agentEvalDefaultOn({ eval: 'false' }), false);
});

test('loadAgentFromFolder + discover; AGENT.md overrides instructions; eval default-on [AC:agent-as-folder-eval#AC-1] [AC:agent-as-folder-eval#AC-2]', () => {
  const root = mkdtempSync(join(tmpdir(), 'aaf-'));
  try {
    writeAgentFolder(
      root,
      'researcher',
      {
        id: 'folder-researcher',
        name: 'Researcher',
        role: 'researcher',
        instructions: 'from-json',
        capabilities: ['research']
      },
      '# From markdown\n\nPrefer this body.\n'
    );
    writeAgentFolder(root, 'opt-out', {
      id: 'folder-opt-out',
      name: 'OptOut',
      role: 'assistant',
      instructions: 'no eval',
      eval: false
    });
    writeFileSync(
      join(root, 'flat.json'),
      JSON.stringify({
        id: 'flat-one',
        name: 'Flat',
        role: 'assistant',
        instructions: 'flat'
      })
    );

    const loaded = loadAgentFromFolder(join(root, 'researcher'));
    assert.ok(loaded);
    assert.equal(loaded.agent.id, 'folder-researcher');
    assert.equal(loaded.agent.instructions.includes('Prefer this body'), true);
    assert.equal(loaded.evalEnabled, true);

    const all = discoverAgentFolders(root);
    assert.equal(all.length, 2);
    const evalOn = agentsWithEvalDefaultOn(all);
    assert.deepEqual(
      evalOn.map((a) => a.id).sort(),
      ['folder-researcher']
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin-loader discovers folder agents alongside flat json [AC:agent-as-folder-eval#AC-1]', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-aaf-'));
  try {
    const pluginDir = join(root, 'demo-plugin');
    mkdirSync(join(pluginDir, 'agents', 'folder-bot'), { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ id: 'demo', name: 'Demo', version: '0.1.0' })
    );
    writeFileSync(
      join(pluginDir, 'agents', 'helper.json'),
      JSON.stringify({
        id: 'demo-helper',
        name: 'Helper',
        role: 'assistant',
        instructions: 'Help',
        capabilities: ['chat']
      })
    );
    writeFileSync(
      join(pluginDir, 'agents', 'folder-bot', 'agent.json'),
      JSON.stringify({
        id: 'demo-folder-bot',
        name: 'FolderBot',
        role: 'assistant',
        instructions: 'I am a folder agent',
        capabilities: ['chat']
      })
    );

    const loaded = loadPluginFromDir(pluginDir);
    assert.ok(loaded);
    const ids = loaded.agents.map((a) => a.id).sort();
    assert.deepEqual(ids, ['demo-folder-bot', 'demo-helper']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
