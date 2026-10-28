import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSkillManifest,
  enforceSkillManifest,
  loadSkillManifestFromMeta,
  PLANNING_SKILL_MANIFEST
} from '../dist/skills/skill-manifest.js';
import { builtinSkills } from '../dist/skills/builtin-skills.js';

test('validateSkillManifest requires version and normalizes network default', () => {
  const r = validateSkillManifest({ version: '1.0.0', allowTools: ['bash'] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.manifest.version, '1.0.0');
  assert.deepEqual(r.manifest.network, { mode: 'none' });
  assert.deepEqual(r.manifest.allowTools, ['bash']);
});

test('validateSkillManifest fails closed on bad shape', () => {
  assert.equal(validateSkillManifest(null).ok, false);
  assert.equal(validateSkillManifest({}).ok, false);
  assert.equal(validateSkillManifest({ version: '1', allowTools: [1] }).ok, false);
  assert.equal(validateSkillManifest({ version: '1', network: { mode: 'allowlist', hosts: [] } }).ok, false);
});

test('enforceSkillManifest deny wins and allow is required when set', () => {
  const m = validateSkillManifest({
    version: '1',
    allowTools: ['read_file', 'TodoWrite'],
    denyTools: ['bash'],
    allowPaths: ['/workspace'],
    network: { mode: 'allowlist', hosts: ['example.com'] }
  });
  assert.equal(m.ok, true);
  if (!m.ok) return;
  assert.equal(enforceSkillManifest(m.manifest, { tool: 'bash' }).ok, false);
  assert.equal(enforceSkillManifest(m.manifest, { tool: 'write_file' }).ok, false);
  assert.equal(enforceSkillManifest(m.manifest, { tool: 'read_file' }).ok, true);
  assert.equal(enforceSkillManifest(m.manifest, { path: '/etc/passwd' }).ok, false);
  assert.equal(enforceSkillManifest(m.manifest, { path: '/workspace/a.ts' }).ok, true);
  assert.equal(enforceSkillManifest(m.manifest, { networkHost: 'evil.test' }).ok, false);
  assert.equal(enforceSkillManifest(m.manifest, { networkHost: 'api.example.com' }).ok, true);
});

test('loadSkillManifestFromMeta reads frontmatter and sibling', () => {
  const absent = loadSkillManifestFromMeta({});
  assert.equal(absent.ok, true);
  assert.equal(absent.manifest, undefined);
  const bad = loadSkillManifestFromMeta({ manifest: { noVersion: true } });
  assert.equal(bad.ok, false);
  const good = loadSkillManifestFromMeta(undefined, { version: '2.0.0', denyTools: ['bash'] });
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.equal(good.manifest.version, '2.0.0');
});

test('omitted allow-lists deny tools and paths [AC:skill-manifest-boundary#AC-1]', () => {
  const m = validateSkillManifest({ version: '1', denyTools: ['bash'] });
  assert.equal(m.ok, true);
  if (!m.ok) return;
  assert.equal(enforceSkillManifest(m.manifest, { tool: 'read_file' }).ok, false);
  assert.equal(enforceSkillManifest(m.manifest, { path: 'src/a.ts' }).ok, false);
});

test('path traversal and prefix tricks stay outside allowPaths [AC:skill-manifest-boundary#AC-2]', () => {
  const m = validateSkillManifest({
    version: '1',
    allowTools: ['read_file'],
    allowPaths: ['/workspace']
  });
  assert.equal(m.ok, true);
  if (!m.ok) return;
  assert.equal(enforceSkillManifest(m.manifest, { path: '/workspace/../etc/passwd' }).ok, false);
  assert.equal(enforceSkillManifest(m.manifest, { path: '/workspace-evil/secret' }).ok, false);
  assert.equal(enforceSkillManifest(m.manifest, { path: '/workspace/src/a.ts' }).ok, true);
});

test('network allowlist rejects lookalike hosts [AC:skill-manifest-boundary#AC-1]', () => {
  const m = validateSkillManifest({
    version: '1',
    allowTools: ['web_fetch'],
    network: { mode: 'allowlist', hosts: ['example.com'] }
  });
  assert.equal(m.ok, true);
  if (!m.ok) return;
  assert.equal(enforceSkillManifest(m.manifest, { networkHost: 'example.com.evil.com' }).ok, false);
  assert.equal(enforceSkillManifest(m.manifest, { networkHost: '' }).ok, false);
  assert.equal(enforceSkillManifest(m.manifest, { networkHost: 'api.example.com' }).ok, true);
});

test('Planning builtin ships a Manifest (capability boundary example)', () => {
  const planning = builtinSkills.find((s) => s.id === 'planning');
  assert.ok(planning);
  assert.ok(planning.manifest);
  assert.equal(planning.manifest.version, PLANNING_SKILL_MANIFEST.version);
  assert.equal(enforceSkillManifest(planning.manifest, { tool: 'bash' }).ok, false);
  assert.equal(enforceSkillManifest(planning.manifest, { tool: 'TodoWrite' }).ok, true);
  assert.equal(enforceSkillManifest(planning.manifest, { networkHost: 'x.com' }).ok, false);
});
