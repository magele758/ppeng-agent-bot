import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL;
    if (parent?.includes('/packages/core/src/') && (specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
      const candidate = join(dirname(fileURLToPath(parent)), specifier).replace(/\.js$/, '.ts');
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.includes('/packages/core/src/') && url.endsWith('.ts')) {
      const path = fileURLToPath(url);
      const source = ts.transpileModule(readFileSync(path, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: path
      }).outputText;
      return { format: 'module', source, shortCircuit: true };
    }
    return next(url, context);
  }
});

test('archived transcript path is workspace-relative [AC:compact-archive-pointer#AC-3]', async () => {
  const { archiveMessages } = await import('../src/runtime/compact-host.ts');
  const repo = mkdtempSync(join(tmpdir(), 'archive-repo-'));
  const stateDir = join(repo, '.agent-state');
  try {
    const rel = await archiveMessages(stateDir, 'sid', [{
      id: 'm1',
      sessionId: 'sid',
      role: 'user',
      parts: [{ type: 'text', text: 'hello archive' }],
      createdAt: '2026-11-04T00:00:00.000Z'
    }]);
    assert.equal(isAbsolute(rel), false);
    assert.match(rel, /^\.agent-state\/transcripts\/sid\/\d+\.jsonl$/);
    assert.equal(rel.includes('hello archive'), false);
    assert.match(readFileSync(resolve(repo, rel), 'utf8'), /hello archive/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
