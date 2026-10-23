import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyLibraryPick, withoutLibraryDir } from './library-dirs-model.ts';

const card = readFileSync(new URL('./LibraryDirsCard.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./knowledge.module.css', import.meta.url), 'utf8');

function cssBlock(name: string): string {
  const match = css.match(new RegExp(`\\.${name}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `missing .${name}`);
  return match[1] ?? '';
}

test('知识页用选择文件夹，没有手填路径框 [AC:knowledge-library-dirs#AC-6]', () => {
  assert.match(card, /id="libraryDirPick"/);
  assert.match(card, /knowledge\.library\.choose/);
  assert.match(card, /\/api\/library\/pick-folder/);
  assert.match(card, /applyLibraryPick/);
  assert.doesNotMatch(card, /<input/);
  assert.doesNotMatch(card, /webkitdirectory/);
  assert.doesNotMatch(card, /libraryDirPath/);
  assert.doesNotMatch(card, /knowledge\.library\.pathPh/);
  assert.doesNotMatch(card, /type="text"/);
});

test('每选一次追加一个目录，重复不加，取消和失败不写入 [AC:knowledge-library-dirs#AC-7] [AC:knowledge-library-dirs#AC-8]', () => {
  const first = '/Users/notes';
  const second = '/Users/archive';
  const added = applyLibraryPick([], { status: 'selected', path: `${first}/` });
  assert.deepEqual(added, { action: 'save', dirs: [first] });
  const both = applyLibraryPick(added.action === 'save' ? added.dirs : [], { status: 'selected', path: second });
  assert.deepEqual(both, { action: 'save', dirs: [first, second] });
  assert.equal(applyLibraryPick([first, second], { status: 'selected', path: `${first}/` }).action, 'duplicate');
  assert.equal(applyLibraryPick([first], { status: 'cancelled' }).action, 'cancelled');
  assert.equal(applyLibraryPick([first], { status: 'unavailable' }).action, 'unavailable');
  assert.equal(applyLibraryPick([first], { status: 'rejected' }).action, 'rejected');
  assert.equal(applyLibraryPick([first], { status: 'selected', path: 'relative/notes' }).action, 'ignore');
  const left = withoutLibraryDir([first, second], first);
  assert.deepEqual(left, [second]);
  assert.deepEqual(withoutLibraryDir(left, second), []);
  assert.match(card, /id="libraryDirEmpty"/);
  assert.match(card, /withoutLibraryDir/);
  assert.match(card, /knowledge\.library\.cancelled/);
  assert.match(card, /knowledge\.library\.unavailable/);
});

test('目录列表行是左右两列，移除不随路径变位置 [AC:knowledge-library-dirs#AC-10]', () => {
  const row = cssBlock('dirRow');
  const path = cssBlock('dirPath');
  const remove = cssBlock('dirRemove');
  const list = cssBlock('dirList');

  assert.match(row, /display:\s*grid/);
  assert.match(row, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  assert.match(row, /align-items:\s*center/);
  assert.match(row, /height:\s*40px/);
  assert.match(path, /min-width:\s*0/);
  assert.match(path, /overflow:\s*hidden/);
  assert.match(path, /text-overflow:\s*ellipsis/);
  assert.match(path, /white-space:\s*nowrap/);
  assert.match(remove, /justify-self:\s*end/);
  assert.match(remove, /white-space:\s*nowrap/);
  assert.match(list, /margin:\s*0/);
  assert.match(list, /padding:\s*0/);
  assert.match(list, /list-style:\s*none/);
  assert.match(list, /width:\s*100%/);

  assert.match(card, /className=\{styles\.dirList\}/);
  assert.match(card, /className=\{styles\.dirRow\}/);
  assert.match(card, /className=\{styles\.dirPath\}/);
  assert.match(card, /styles\.dirRemove/);
  const rowMarkup = card.slice(card.indexOf('styles.dirRow'));
  const pathAt = rowMarkup.indexOf('styles.dirPath');
  const removeAt = rowMarkup.indexOf('styles.dirRemove');
  assert.ok(pathAt >= 0 && removeAt > pathAt, 'path column then remove column');
});
