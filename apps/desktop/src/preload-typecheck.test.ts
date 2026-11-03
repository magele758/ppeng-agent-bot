import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markDesktopGlass } from './preload.ts';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');

type ClassListTarget = { classList: { add(token: string): void } };

function glassDocument(root: ClassListTarget | null) {
  const added: string[] = [];
  let listener: (() => void) | undefined;
  let eventName = '';
  const doc = {
    documentElement: root,
    addEventListener(type: string, fn: () => void) {
      eventName = type;
      listener = fn;
    }
  };
  if (root) {
    root.classList.add = (token: string) => {
      added.push(token);
    };
  }
  return { doc, added, eventName: () => eventName, listener: () => listener };
}

function tscBin(): string {
  const require = createRequire(join(desktopDir, 'package.json'));
  return join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

function compilerFiles(project: string): { status: number; files: string[]; output: string } {
  const result = spawnSync(process.execPath, [tscBin(), '-p', project, '--noEmit', '--listFiles', '--pretty', 'false'], {
    cwd: desktopDir,
    encoding: 'utf8'
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const files = output.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.d.ts') || line.endsWith('.ts'));
  return { status: result.status ?? 1, files, output };
}

function hasDomLib(files: string[]): boolean {
  return files.some((file) => file.endsWith('/lib.dom.d.ts') || file.endsWith('\\lib.dom.d.ts'));
}

test('[AC:desktop-preload-typecheck#AC-1] desktop pack typecheck accepts preload document and keeps DOM out of main', () => {
  const pkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as { scripts: { build: string } };
  assert.match(pkg.scripts.build, /tsc\s+-p\s+tsconfig\.json\s+&&\s+tsc\s+-p\s+tsconfig\.preload\.json/);

  const main = compilerFiles('tsconfig.json');
  assert.equal(main.status, 0, main.output);
  assert.equal(main.files.some((file) => file.endsWith('/src/main.ts') || file.endsWith('\\src\\main.ts')), true);
  assert.equal(main.files.some((file) => file.endsWith('/src/preload.ts') || file.endsWith('\\src\\preload.ts')), false);
  assert.equal(hasDomLib(main.files), false);

  const preload = compilerFiles('tsconfig.preload.json');
  assert.equal(preload.status, 0, preload.output);
  assert.equal(preload.files.some((file) => file.endsWith('/src/preload.ts') || file.endsWith('\\src\\preload.ts')), true);
  assert.equal(preload.files.some((file) => file.endsWith('/src/main.ts') || file.endsWith('\\src\\main.ts')), false);
  assert.equal(hasDomLib(preload.files), true);
});

test('[AC:desktop-preload-typecheck#AC-2] existing root gets desktop-glass immediately', () => {
  const root: ClassListTarget = { classList: { add() {} } };
  const harness = glassDocument(root);
  markDesktopGlass(harness.doc);
  assert.deepEqual(harness.added, ['desktop-glass']);
  assert.equal(harness.listener(), undefined);
});

test('[AC:desktop-preload-typecheck#AC-2] root that appears later gets desktop-glass on DOMContentLoaded', () => {
  const harness = glassDocument(null);
  markDesktopGlass(harness.doc);
  assert.deepEqual(harness.added, []);
  assert.equal(harness.eventName(), 'DOMContentLoaded');
  const root: ClassListTarget = { classList: { add() {} } };
  harness.doc.documentElement = root;
  root.classList.add = (token: string) => {
    harness.added.push(token);
  };
  const listener = harness.listener();
  if (listener === undefined) {
    assert.fail('DOMContentLoaded listener was not registered');
  }
  listener();
  assert.deepEqual(harness.added, ['desktop-glass']);
});
