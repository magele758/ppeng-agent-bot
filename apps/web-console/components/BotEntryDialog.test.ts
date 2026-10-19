import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shellCssPath = new URL('./BotEntryDialog.css', import.meta.url);
const legacyCssPath = new URL('./play-group/play-group.css', import.meta.url);
const dialogPath = new URL('./BotEntryDialog.tsx', import.meta.url);
const createFormPath = new URL('./sections/agents/BotCreateForm.tsx', import.meta.url);

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing rule ${selector}`);
  return match[1];
}

test('新建 Bot 弹窗没有白边，背后是半透明遮罩 [AC:bot-entry-dialog-shell#AC-1]', () => {
  const legacy = readFileSync(legacyCssPath, 'utf8');
  assert.doesNotMatch(legacy, /\.bot-entry-backdrop/);
  assert.doesNotMatch(legacy, /\.bot-entry-dialog/);
  const shell = readFileSync(shellCssPath, 'utf8');
  const backdrop = rule(shell, '.bot-entry-backdrop');
  const dialog = rule(shell, '.bot-entry-dialog');
  assert.match(backdrop, /position:\s*fixed/);
  assert.match(backdrop, /inset:\s*0/);
  assert.match(backdrop, /background:\s*rgb\(0 0 0 \/ 0\.6\)/);
  assert.match(dialog, /background:\s*var\(--ui-surface\)/);
  assert.match(dialog, /border:\s*none/);
  assert.match(dialog, /outline:\s*none/);
  assert.doesNotMatch(dialog, /#fff|#ddd|white|var\(--surface|--border/);
});

test('创建和取消固定在弹窗底部，中间内容单独滚动 [AC:bot-entry-dialog-shell#AC-2]', () => {
  const shell = readFileSync(shellCssPath, 'utf8');
  const dialog = rule(shell, '.bot-entry-dialog');
  const scroll = rule(shell, '.bot-entry-dialog .ag-form__scroll');
  const actions = rule(shell, '.bot-entry-dialog .ag-form__actions');
  assert.match(dialog, /overflow:\s*hidden/);
  assert.doesNotMatch(dialog, /overflow:\s*auto/);
  assert.match(scroll, /overflow:\s*auto/);
  assert.match(scroll, /min-height:\s*0/);
  assert.match(actions, /flex:\s*0 0 auto/);
  const form = readFileSync(createFormPath, 'utf8');
  const scrollAt = form.indexOf('className="ag-form__scroll"');
  const actionsAt = form.indexOf('className="ag-form__actions"');
  assert.ok(scrollAt > 0 && actionsAt > scrollAt);
  const between = form.slice(scrollAt, actionsAt);
  assert.match(between, /BotFaceChoice/);
  assert.match(between, /<\/div>/);
  assert.doesNotMatch(between, /bot-create-submit/);
});

test('点击遮罩关闭弹窗，点击内部不关闭 [AC:bot-entry-dialog-shell#AC-3] [AC:bot-entry-dialog-shell#AC-4]', async () => {
  const { shouldDismissEntryDialog } = await import('../lib/entry-dialog.ts');
  const backdrop = {};
  const dialog = {};
  assert.equal(shouldDismissEntryDialog(true, backdrop, backdrop), true);
  assert.equal(shouldDismissEntryDialog(true, dialog, backdrop), false);
  assert.equal(shouldDismissEntryDialog(false, backdrop, backdrop), false);
  const source = readFileSync(dialogPath, 'utf8');
  assert.match(source, /shouldDismissEntryDialog/);
  assert.match(source, /activateEntryDialogCancel/);
});

test('Esc 仍关闭弹窗，进行中的提交不会被关掉 [AC:bot-entry-dialog-shell#AC-5]', async () => {
  const { activateEntryDialogCancel } = await import('../lib/entry-dialog.ts');
  const clicks: string[] = [];
  const root = {
    querySelectorAll(selector: string) {
      assert.equal(selector, 'button[type="button"]');
      return [
        { disabled: false, click: () => clicks.push('submit-lookalike') },
        { disabled: false, click: () => clicks.push('cancel') }
      ];
    }
  };
  assert.equal(activateEntryDialogCancel(root), true);
  assert.deepEqual(clicks, ['cancel']);
  const busy = {
    querySelectorAll() {
      return [{ disabled: true, click: () => clicks.push('busy') }];
    }
  };
  assert.equal(activateEntryDialogCancel(busy), false);
  assert.deepEqual(clicks, ['cancel']);
  const source = readFileSync(dialogPath, 'utf8');
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /activateEntryDialogCancel/);
});
