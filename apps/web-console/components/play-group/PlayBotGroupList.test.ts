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

test('群聊行默认不显示删除文字按钮 [AC:play-group-delete-menu#AC-1]', () => {
  const { children } = deleteButtonParts(list);
  assert.match(css, /\.play-group-menu\s*\{[^}]*opacity:\s*0/);
  assert.match(css, /\.play-group-menu\s*\{[^}]*pointer-events:\s*none/);
  assert.doesNotMatch(children, /deleteLabel|deleting|删除|Delete/);
  assert.equal(list.includes('>删除<'), false);
  assert.equal(list.includes('>Delete<'), false);
});

test('悬停、键盘聚焦和触摸设备露出可聚焦的删除图标 [AC:play-group-delete-menu#AC-2]', () => {
  const { openTag, children } = deleteButtonParts(list);
  const menuAt = list.indexOf('data-testid="play-group-menu"');
  const buttonAt = list.indexOf('data-testid="play-group-delete"');
  assert.ok(menuAt > 0 && menuAt < buttonAt);
  assert.match(children, /<WorkspaceIcon kind="trash" \/>/);
  assert.match(openTag, /btn-icon/);
  assert.match(openTag, /play\.group\.deleteAria/);
  assert.match(icons, /'trash'/);
  assert.match(icons, /trash:\s*'[^']+'/);
  assert.match(css, /\.list-item--group:hover\s*>\s*\.play-group-menu/);
  assert.match(css, /\.list-item--group:focus-within\s*>\s*\.play-group-menu/);
  assert.match(css, /\.play-group-menu:focus-within/);
  const hoverAt = css.indexOf('.list-item--group:hover > .play-group-menu');
  assert.match(css.slice(hoverAt, hoverAt + 320), /opacity:\s*1/);
  const mediaAt = css.search(/@media\s*\(\s*hover:\s*none\s*\)\s*,\s*\(\s*pointer:\s*coarse\s*\)/);
  assert.ok(mediaAt >= 0);
  assert.match(css.slice(mediaAt, mediaAt + 240), /opacity:\s*1/);
  assert.match(zh.play.group.deleteAria, /删除群聊 \{title\}/);
  assert.match(en.play.group.deleteAria, /Delete group chat \{title\}/);
  assert.notEqual(zh.play.group.deleteAria, en.play.group.deleteAria);
  assert.notEqual(zh.play.group.deleteLabel, en.play.group.deleteLabel);
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
