import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAllSkills } from '../dist/skills/builtin-skills.js';
import { loadPluginFromDir, pluginMcpCommand } from '../dist/plugins/plugin-loader.js';
import { connectGrantedPluginMcp } from '../dist/plugins/plugin-mcp.js';
import { ensureRepoTrust, filterUntrustedRepoHooks, setRepoTrust } from '../dist/trust/repo-trust.js';

function skillRepo(root: string): void {
  const dir = join(root, 'skills', 'demo-trust');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: DemoTrustSkill\ndescription: repo only\n---\nbody\n');
}

test('missing trust migrates to trusted and an explicit false skips repo skills', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-trust-'));
  const state = mkdtempSync(join(tmpdir(), 'repo-trust-state-'));
  try {
    skillRepo(repo);
    const trusted = await loadAllSkills(repo, state);
    assert.equal(trusted.some((skill) => skill.name === 'DemoTrustSkill'), true);
    assert.equal(ensureRepoTrust(state, repo).migrated, true);
    assert.equal((await loadAllSkills(repo)).some((skill) => skill.name === 'DemoTrustSkill'), true);

    setRepoTrust(state, repo, false);
    const blocked = await loadAllSkills(repo, state);
    assert.equal(blocked.some((skill) => skill.name === 'DemoTrustSkill'), false);
    assert.equal(blocked.some((skill) => skill.id === 'planning'), true);
    assert.equal(ensureRepoTrust(state, repo).trusted, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('untrusted repos drop only hook scripts that live inside the repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-hooks-'));
  try {
    const hookEnv = {
      RAW_AGENT_HOOK_PRE_TOOL: join(repo, 'hooks', 'pre.js'),
      RAW_AGENT_HOOK_STOP: join(tmpdir(), 'operator-stop.js')
    };
    const kept = filterUntrustedRepoHooks(hookEnv, repo, false);
    assert.equal(kept.RAW_AGENT_HOOK_PRE_TOOL, undefined);
    assert.equal(kept.RAW_AGENT_HOOK_STOP, hookEnv.RAW_AGENT_HOOK_STOP);
    assert.equal(filterUntrustedRepoHooks(hookEnv, repo, true).RAW_AGENT_HOOK_PRE_TOOL, hookEnv.RAW_AGENT_HOOK_PRE_TOOL);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('plugin mcp command is returned only after grant', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-mcp-'));
  try {
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({
      id: 'demo',
      name: 'Demo',
      mcp: { command: 'npx', args: ['srv'] }
    }));
    const plugin = loadPluginFromDir(root);
    assert.ok(plugin);
    assert.equal(pluginMcpCommand(plugin!, false), undefined);
    assert.deepEqual(pluginMcpCommand(plugin!, true), { command: 'npx', args: ['srv'] });

    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ id: 'demo', name: 'Demo', mcp: { command: '  ' } }));
    const empty = loadPluginFromDir(root);
    assert.equal(empty?.mcp, undefined);
    assert.equal(pluginMcpCommand(empty!, true), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin mcp connects only after grant and skips an untrusted repo copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-mcp-connect-'));
  const outside = mkdtempSync(join(tmpdir(), 'plugin-mcp-user-'));
  try {
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({
      id: 'repo-demo',
      name: 'Repo',
      mcp: { command: 'npx', args: ['repo-srv'] }
    }));
    writeFileSync(join(outside, 'plugin.json'), JSON.stringify({
      id: 'user-demo',
      name: 'User',
      mcp: { command: 'npx', args: ['user-srv'] }
    }));
    const repoPlugin = loadPluginFromDir(root);
    const userPlugin = loadPluginFromDir(outside);
    assert.ok(repoPlugin && userPlugin);
    const plugins = [repoPlugin!, userPlugin!];
    const seen: string[] = [];
    const connect = async (config: { command: string; args: string[]; env: Record<string, string> }) => {
      seen.push(config.args[0] ?? '');
      assert.equal(config.command, 'npx');
      assert.equal(config.env.LD_PRELOAD, undefined);
    };
    const env = { ...process.env, LD_PRELOAD: 'evil.so' };
    assert.equal(await connectGrantedPluginMcp(plugins, { granted: () => false, env }, connect), 0);
    assert.deepEqual(seen, []);

    await connectGrantedPluginMcp(plugins, {
      granted: (plugin) => plugin.manifest.id === 'repo-demo',
      repoRoot: root,
      repoTrusted: false,
      env
    }, connect);
    assert.deepEqual(seen, []);

    await connectGrantedPluginMcp(plugins, {
      granted: (plugin) => plugin.manifest.id === 'user-demo',
      repoRoot: root,
      repoTrusted: false,
      env
    }, connect);
    assert.deepEqual(seen, ['user-srv']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
