import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { en } from '../../lib/i18n/messages/en/index.ts';
import { zh } from '../../lib/i18n/messages/zh/index.ts';

const list = readFileSync(new URL('./PlayBotGroupList.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./play-group.css', import.meta.url), 'utf8');
const icons = readFileSync(new URL('../WorkspaceIcon.tsx', import.meta.url), 'utf8');

function deleteButtonParts(source: string) {
  const marker = 'data-testid="play-group-delete"';
  const start = source.indexOf(marker);
  assert.ok(start > 0, 'missing play-group-delete');
  const openEnd = source.indexOf('>', start);
  const close = source.indexOf('</button>', openEnd);
  assert.ok(openEnd > start && close > openEnd);
  return {
    openTag: source.slice(source.lastIndexOf('<button', start), openEnd),
    children: source.slice(openEnd + 1, close)
  };
}

test('群聊删除仅放在更多菜单 [AC:play-group-delete-menu#AC-1]', () => {
  const menu=readFileSync(new URL('../RowActionMenu.tsx',import.meta.url),'utf8');
  assert.match(menu,/popover="auto"/);
  assert.match(menu,/popoverTarget=\{id\}/);
  assert.ok(list.indexOf('<RowActionMenu') < list.indexOf('data-testid="play-group-delete"'));
});

test('菜单删除保留键盘入口与无障碍名称 [AC:play-group-delete-menu#AC-2]', () => {
  const {openTag}=deleteButtonParts(list);
  assert.match(openTag,/type="button"/);
  assert.match(openTag,/play\.group\.deleteAria/);
  assert.match(zh.play.group.deleteAria,/删除群聊 \{title\}/);
  assert.match(en.play.group.deleteAria,/Delete group chat \{title\}/);
});

test('点删除图标仍先确认，取消或失败都不误删 [AC:play-group-delete-menu#AC-3]', () => {
  assert.match(list, /window\.confirm\(t\('play\.group\.deleteConfirm', \{ title: room\.title \}\)\)/);
  assert.match(list, /if \(deletingId \|\| !window\.confirm/);
  assert.match(list, /setDeleteError\(t\('play\.group\.deleteFailed'\)\)/);
  assert.match(list, /data-testid="play-group-delete-error"/);
  assert.match(list, /method: 'DELETE'/);
  assert.match(zh.play.group.deleteConfirm, /成员 Bot 和私人对话会保留/);
  assert.match(en.play.group.deleteConfirm, /private conversations will be kept/);
});
