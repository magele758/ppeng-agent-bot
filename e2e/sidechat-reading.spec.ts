import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

test('长回复的选中行在开栏后保持高度，关栏跟随用户后来读到的行 [AC:sidechat#AC-4] [AC:sidechat#AC-5]', async ({
  page
}) => {
  // A long, real browser text layout isolates reflow from model-specific reply lengths.
  await page.setContent(
    '<style>#feed{width:630px;height:310px;line-height:24px;overflow:auto;overflow-anchor:none}p{margin:0}</style><div id="feed"><div class="chat-bubble__body"></div></div>'
  );
  const source = await readFile('apps/web-console/components/sidechat/rail-reading-line.ts', 'utf8');
  await page.addScriptTag({
    content:
      'var exports={};' +
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
      }).outputText
  });
  const positions = await page.evaluate(() => {
    const io = (
      window as unknown as {
        exports: {
          captureLine: (feed: Element, preferred?: Range | null) => { range: Range; y: number };
          restoreLine: (feed: Element, mark: unknown) => boolean;
        };
      }
    ).exports;
    const feed = document.querySelector<HTMLElement>('#feed')!;
    const body = feed.firstElementChild!;
    for (let i = 0; i < 110; i++) {
      const p = document.createElement('p');
      p.textContent = (
        'Paragraph ' +
        i +
        ' with enough detail to wrap differently after a change in reading width. '
      ).repeat(3);
      body.append(p);
    }
    const range = document.createRange();
    range.setStart(body.children[35]!.firstChild!, 155);
    range.setEnd(body.children[35]!.firstChild!, 156);
    feed.scrollTop = range.getBoundingClientRect().top - feed.getBoundingClientRect().top - 95;
    const start = range.getBoundingClientRect().top;
    const chosen = io.captureLine(feed, range);
    feed.style.width = '380px';
    io.restoreLine(feed, chosen);
    const openError = Math.abs(start - range.getBoundingClientRect().top);
    feed.scrollTop += 2200;
    const now = io.captureLine(feed);
    const newY = now.range.getBoundingClientRect().top;
    feed.style.width = '630px';
    io.restoreLine(feed, now);
    return {
      openError,
      closeError: Math.abs(now.range.getBoundingClientRect().top - newY),
      distance: Math.abs(range.getBoundingClientRect().top - start)
    };
  });
  expect(positions.openError).toBeLessThan(2);
  expect(positions.closeError).toBeLessThan(2);
  expect(positions.distance).toBeGreaterThan(300);
});

test('同一引文的标记告诉读屏用户批注数，切换活动讨论不会重建标记 [AC:sidechat#AC-4]', async ({ page }) => {
  await page.setContent(
    '<article id="reply"><p class="chat-bubble__body chat-bubble__md">这一段解释 KV cache。</p></article>'
  );
  const compile = async (file: string) =>
    ts.transpileModule(await readFile(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
  const anchors = await compile('apps/web-console/lib/sidechat-anchor.ts');
  const dom = await compile('apps/web-console/components/sidechat/source-dom.ts');
  await page.addScriptTag({
    content: 'var exports={};' + anchors + ';var anchors=exports;exports={};var require=()=>anchors;' + dom
  });
  const actual = await page.evaluate(() => {
    type MarkerApi = {
      paintSidechatMarks: (row: Element, threads: object[], label: (q: string, n: number) => string) => void;
      setActiveMarks: (row: Element, id: string | null) => void;
    };
    const api = (window as unknown as { exports: MarkerApi }).exports;
    const reply = document.getElementById('reply')!;
    const threads = ['a', 'b'].map((id, i) => ({
      id,
      ordinal: i + 1,
      title: id,
      anchor: { kind: 'range', quote: 'KV cache' }
    }));
    api.paintSidechatMarks(reply, threads, (quote, count) => quote + ' · ' + count + ' 条批注');
    const mark = reply.querySelector<HTMLElement>('[data-sidechat-ids]')!;
    mark.focus();
    api.setActiveMarks(reply, 'b');
    const pressed = mark.getAttribute('aria-pressed');
    api.setActiveMarks(reply, null);
    return {
      label: mark.getAttribute('aria-label'),
      ordinal: mark.dataset.sidechatOrdinal,
      pressed,
      closed: mark.hasAttribute('data-sidechat-active'),
      focused: document.activeElement === mark
    };
  });
  expect(actual).toEqual({
    label: 'KV cache · 2 条批注',
    ordinal: '1·2',
    pressed: 'true',
    closed: false,
    focused: true
  });
});
