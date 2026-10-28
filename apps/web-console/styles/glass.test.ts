import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const glass = readFileSync(join(root, 'glass.css'), 'utf8');
const globals = readFileSync(join(root, '../app/globals.css'), 'utf8');

function blockAfter(css: string, selector: string): string {
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, `missing ${selector}`);
  return css.slice(at, css.indexOf('}', at) + 1);
}

test('[AC:app-frosted-glass#AC-1] glass contract is imported last and panels blur', () => {
  const imports = [...globals.matchAll(/@import\s+['"][^'"]+['"]/g)].map((m) => m[0]);
  assert.ok(imports.length > 0);
  assert.match(imports.at(-1)!, /glass\.css/);
  assert.match(glass, /--glass-filter:\s*blur\(/);

  for (const selector of ['.lab-rail', '.card']) {
    const rule = blockAfter(glass, selector);
    assert.match(rule, /var\(--glass-fill(?:-strong)?\)/);
    assert.match(rule, /backdrop-filter:\s*var\(--glass-filter\)/);
  }
  const skins = blockAfter(glass, 'html[data-skin] :is(.lab-rail');
  assert.match(skins, /var\(--glass-fill\)/);
  assert.match(skins, /backdrop-filter:\s*var\(--glass-filter\)/);
});

test('[AC:app-frosted-glass#AC-2] reduced transparency drops blur and desktop glass is clear', () => {
  const reduced = glass.slice(glass.indexOf('prefers-reduced-transparency'));
  assert.match(reduced, /--glass-filter:\s*none/);
  const desktop = blockAfter(glass, 'html.desktop-glass body');
  assert.match(desktop, /background:\s*transparent/);
});
