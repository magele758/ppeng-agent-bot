import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';

const rooms = readFileSync(new URL('../components/bot-work/BotRooms.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../components/play-group/play-group.css', import.meta.url), 'utf8');

test('群聊设置把名称和保存放在同一表单，不靠群消息历史才能保存 [AC:group-chat-settings-save#AC-2] [AC:group-chat-settings-save#AC-3]', () => {
  assert.match(rooms, /data-testid="room-settings-form"/);
  assert.match(rooms, /data-testid="room-settings-title"/);
  assert.match(rooms, /data-testid="room-save"/);
  const form = rooms.indexOf('data-testid="room-settings-form"');
  const title = rooms.indexOf('data-testid="room-settings-title"');
  const save = rooms.indexOf('data-testid="room-save"');
  const formEnd = rooms.indexOf('</form>', form);
  const message = rooms.indexOf("botWork.message");
  assert.ok(form >= 0 && save > form && title > form && formEnd > title && formEnd > save);
  assert.ok(message === -1 || formEnd < message);
  assert.match(rooms, /play-group-settings-save/);
  assert.match(rooms, /void open\(data\.room\)/);
  assert.doesNotMatch(rooms.slice(rooms.indexOf('if (selectedRoomId)'), rooms.indexOf('} else await load()')), /await open\(data\.room\)/);
  assert.match(styles, /\.play-group-settings[^}]*min-height:\s*0/);
  assert.equal(zh.play.groupSettings.saved, '已保存');
  assert.equal(en.play.groupSettings.saved, 'Saved');
  assert.notEqual(zh.play.groupSettings.saved, en.play.groupSettings.saved);
});
