/** Build once, test the packed public artifacts, publish those exact bytes. */
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { rewriteScope } from './publish-npm-lib.mjs';
import { resolveBin, sanitizeScriptEnv } from './spawn-utils.mjs';

export const PUBLIC_PACKAGES = ['api-types', 'agent-loop'];
export const PUBLIC_PACK_FILES = ['package.json', 'dist', 'README.md', 'LICENSE', 'SKILL.md'];

export function runArtifactCommand(command, args, cwd, env = process.env) {
  const result = spawnSync(resolveBin(command), args, {
    cwd, env: sanitizeScriptEnv(env), encoding: 'utf8', timeout: 180_000, maxBuffer: 10 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed: ${result.error?.message ?? (result.stderr || result.stdout || String(result.status)).slice(-3000)}`);
  }
  return result.stdout;
}

function rewriteTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) rewriteTree(file);
    else if (/\.(js|cjs|mjs|ts|map|md|json)$/.test(entry.name)) {
      const before = readFileSync(file, 'utf8');
      const after = rewriteScope(before);
      if (after !== before) writeFileSync(file, after);
    }
  }
}

export function packPublicArtifacts(repoRoot, staging, env = process.env) {
  return PUBLIC_PACKAGES.map(name => {
    const src = join(repoRoot, 'packages', name);
    const dest = join(staging, name);
    mkdirSync(dest, { recursive: true });
    for (const file of PUBLIC_PACK_FILES) {
      if (existsSync(join(src, file))) cpSync(join(src, file), join(dest, file), { recursive: true });
    }
    rewriteTree(dest);
    const pkgFile = join(dest, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    pkg.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' };
    if (env.GITHUB_REPOSITORY) pkg.repository = { type: 'git', url: `git+https://github.com/${env.GITHUB_REPOSITORY}.git` };
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
    const output = runArtifactCommand('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', staging], dest, env);
    const [packed] = JSON.parse(output);
    const tarball = join(staging, packed.filename);
    return { name: pkg.name, version: pkg.version, tarball, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') };
  });
}

/** Follow emitted static imports/exports, including side-effect imports; reject Node builtins. */
export function assertPortableMini(entry, seen = new Set()) {
  const file = resolve(entry);
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    const spec = node.moduleSpecifier?.text;
    if (!spec) continue;
    if (spec.startsWith('node:') || builtinModules.includes(spec)) throw new Error(`mini statically imports Node builtin: ${spec} in ${file}`);
    if (spec.startsWith('.')) assertPortableMini(resolve(dirname(file), spec), seen);
    else throw new Error(`mini has unverified external static import: ${spec}`);
  }
  return seen;
}

export function verifyPublicArtifacts(repoRoot, staging, artifacts, env = process.env) {
  const consumer = join(staging, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  runArtifactCommand('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', ...artifacts.map(a => a.tarball)], consumer, env);
  const loopRoot = join(consumer, 'node_modules', '@mage-ai-lab', 'agent-loop');
  const miniFiles = assertPortableMini(join(loopRoot, 'dist', 'mini.js')).size;
  const testFile = join(consumer, 'smoke.mjs');
  writeFileSync(testFile, `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMiniAssembledLoop, createDefaultMemoryStore, DEFAULT_EMBED_AGENT } from '@mage-ai-lab/agent-loop/mini';
for (const name of ['api-types', 'agent-loop']) {
  const pkg = JSON.parse(readFileSync('./node_modules/@mage-ai-lab/' + name + '/package.json', 'utf8'));
  for (const subpath of Object.keys(pkg.exports ?? { '.': pkg.main })) {
    await import('@mage-ai-lab/' + name + (subpath === '.' ? '' : subpath.slice(1)));
  }
}
const { store, surface } = createDefaultMemoryStore({ agent: DEFAULT_EMBED_AGENT });
const session = surface.createSession({ title: 'tarball-smoke', mode: 'chat', agentId: DEFAULT_EMBED_AGENT.id });
surface.appendMessage(session.id, 'user', [{ type: 'text', text: 'hi' }]);
const loop = createMiniAssembledLoop({ io: { store, model: {
  name: 'artifact-smoke',
  async runTurn() { return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'artifact-ok' }] }; },
  async summarizeMessages() { return ''; }
} } });
assert.equal((await loop.run(session.id)).status, 'idle');
assert.ok(store.foldMessages(session.id).some(m => m.parts.some(p => p.type === 'text' && p.text === 'artifact-ok')));
console.log('public exports + mini session passed');
`);
  runArtifactCommand(process.execPath, [testFile], consumer, env);
  const packagedSkill = readFileSync(join(loopRoot, 'SKILL.md'), 'utf8');
  if (!packagedSkill.includes('loop.createHandle(session.id)')) {
    throw new Error('published @mage-ai-lab/agent-loop is missing the createHandle quickstart');
  }
  if (/createAgentLoop\s*\(/.test(packagedSkill)) {
    throw new Error('published SKILL.md still calls createAgentLoop');
  }
  const pkg = JSON.parse(readFileSync(join(loopRoot, 'package.json'), 'utf8'));
  const imports = Object.keys(pkg.exports).map((sub, i) => `import type * as Entry${i} from '@mage-ai-lab/agent-loop${sub === '.' ? '' : sub.slice(1)}';`).join('\n');
  writeFileSync(join(consumer, 'types.mts'), imports);
  runArtifactCommand(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', 'types.mts'], consumer, env);
  const evidence = { schemaVersion: 1, node: process.version, miniStaticFiles: miniFiles, artifacts: artifacts.map(({ tarball, ...record }) => record), checks: ['install', 'exports', 'types-resolve', 'mini-static-portability', 'mini-session'] };
  writeFileSync(join(staging, 'artifact-evidence.json'), JSON.stringify(evidence, null, 2));
  return evidence;
}
