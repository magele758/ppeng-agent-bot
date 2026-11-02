import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PLAY_RAIL_OPEN_STORAGE_KEY, readPlayRailOpen, writePlayRailOpen } from './play-rail-open.ts';

const panel = readFileSync(new URL('../components/PlayPanel.tsx', import.meta.url), 'utf8');

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    data
  };
}

test('右侧栏首次默认关闭 [AC:play-rail-default-closed#AC-1]', () => {
  assert.match(panel, /const \[railCollapsed, setRailCollapsed\] = useState\(true\);/);
  assert.match(panel, /setRailCollapsed\(!readPlayRailOpen\(\)\)/);
  assert.equal(readPlayRailOpen(memoryStorage()), false);
  assert.equal(readPlayRailOpen(null), false);
  const throwing = { getItem: () => { throw new Error('denied'); } };
  assert.equal(readPlayRailOpen(throwing), false);
});

test('手动切换后记住偏好 [AC:play-rail-default-closed#AC-2]', () => {
  const storage = memoryStorage();
  writePlayRailOpen(true, storage);
  assert.equal(readPlayRailOpen(storage), true);
  writePlayRailOpen(false, storage);
  assert.equal(readPlayRailOpen(storage), false);
  assert.equal(PLAY_RAIL_OPEN_STORAGE_KEY, 'lab.playRailOpen');
  assert.equal(storage.data.has('lab.railCollapsed'), false);
  assert.match(panel, /writePlayRailOpen\(!next\)/);
});

test('有活动时不自动展开 [AC:play-rail-default-closed#AC-3]', () => {
  const calls = panel.match(/setRailCollapsed\(/g) ?? [];
  assert.equal(calls.length, 2, 'only the mount read and the header toggle may change the rail');
  assert.equal(/setRailCollapsed\(false\)/.test(panel), false);
});
