import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const files = [
  new URL('./settings.css', import.meta.url),
  new URL('../agents/agents.css', import.meta.url),
  new URL('../../bot-work/bot-goals.css', import.meta.url),
  new URL('../../auth.css', import.meta.url),
  new URL('../../../styles/primitives.css', import.meta.url),
  new URL('../../../styles/skin-menu.css', import.meta.url),
  new URL('../../goal-history.css', import.meta.url),
];

function rule(css: string, selector: string): string {
  const at = css.search(new RegExp(`${selector.replaceAll('.', '\\.')}\\s*\\{`));
  assert.ok(at >= 0, `missing ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

test('设置卡片、代理面板、菜单和目标卡使用毛玻璃变量 [AC:app-frosted-glass#AC-1]', () => {
  const css = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  for (const selector of ['.onboarding-banner', '.ag-card', '.ag-panel', '.ui-group', '.login-card', '.skin-menu__list', '.goal-history__body', '.bot-goals']) {
    const body = rule(css, selector);
    assert.match(body, /background:\s*var\(--glass-fill\)/);
    assert.match(body, /backdrop-filter:\s*var\(--glass-filter\)/);
    assert.match(body, /-webkit-backdrop-filter:\s*var\(--glass-filter\)/);
  }
  const selected = rule(readFileSync(files[0], 'utf8'), '.chip.is-on');
  assert.match(selected, /background:\s*var\(--ui-text\)/);
  assert.doesNotMatch(selected, /--glass-fill/);
});
