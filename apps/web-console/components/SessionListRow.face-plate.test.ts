import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import sharp from 'sharp';
import { BOT_FACE_PICKER_SHAPES, BOT_FACE_SWATCH } from '../lib/bot-face.ts';
import type { BotInfo, SessionSummary } from '../lib/types.ts';

const localRequire = createRequire(import.meta.url);
const cache = new Map<string, Record<string, unknown>>();

function resolveLocal(id: string, from: URL): URL {
  const exact = new URL(id, from);
  if (existsSync(exact.pathname)) return exact;
  if (existsSync(`${exact.pathname}.ts`)) return new URL(`${exact.href}.ts`);
  if (existsSync(`${exact.pathname}.tsx`)) return new URL(`${exact.href}.tsx`);
  throw new Error(`Cannot resolve ${id} from ${from.pathname}`);
}

function loadFile(file: URL): Record<string, unknown> {
  const key = file.pathname;
  const cached = cache.get(key);
  if (cached) return cached;
  const source = readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return JsxRuntime;
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string) => key }) };
    if (id === '@/lib/bot-face') return localRequire('../lib/bot-face.ts');
    if (id === '@/lib/soft-bot-face') return localRequire('../lib/soft-bot-face.ts');
    if (id === '@/lib/session-row') return localRequire('../lib/session-row.ts');
    if (id === '@/lib/types') return localRequire('../lib/types.ts');
    if (id.endsWith('BotWorkState')) return { useBotWorkMood: () => 'idle' };
    if (id.startsWith('.')) return loadFile(resolveLocal(id, file));
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  cache.set(key, mod.exports);
  return mod.exports;
}

const { SessionListRow } = loadFile(new URL('./SessionListRow.tsx', import.meta.url)) as {
  SessionListRow: React.ComponentType<Record<string, unknown>>;
};
const { BotFaceCatalog } = loadFile(new URL('./BotFaceCatalog.tsx', import.meta.url)) as {
  BotFaceCatalog: React.ComponentType<{ bots: readonly BotInfo[]; children?: React.ReactNode }>;
};

function bot(over: Partial<BotInfo> & Pick<BotInfo, 'id' | 'name' | 'canonicalSessionId'>): BotInfo {
  return {
    title: over.name,
    description: '',
    agentId: over.id,
    hidden: false,
    createdAt: '',
    updatedAt: '',
    ...over
  };
}

const roster = [
  bot({ id: 'heart', name: 'Heart Bot', canonicalSessionId: 'sess-heart', faceShape: 'heart', faceColor: 'red' }),
  bot({ id: 'circle', name: 'Circle Bot', canonicalSessionId: 'sess-circle', faceShape: 'circle', faceColor: 'blue' }),
  bot({ id: 'cloud', name: 'Cloud Bot', canonicalSessionId: 'sess-cloud', faceShape: 'cloud', faceColor: 'purple' }),
  bot({ id: 'flower', name: 'Flower Bot', canonicalSessionId: 'sess-flower', faceShape: 'flower', faceColor: 'green' }),
  bot({ id: 'bean', name: 'Bean Bot', canonicalSessionId: 'sess-bean', faceShape: 'bean', faceColor: 'orange' }),
  bot({ id: 'super', name: 'Super Bot', canonicalSessionId: 'sess-super', faceShape: 'bean', faceColor: 'teal' }),
  ...BOT_FACE_PICKER_SHAPES.filter((shape) => !['circle', 'cloud', 'flower', 'bean', 'heart'].includes(shape)).map((shape) =>
    bot({
      id: shape,
      name: `${shape} Bot`,
      canonicalSessionId: `sess-${shape}`,
      faceShape: shape,
      faceColor: 'teal'
    })
  ),
  bot({ id: 'emoji', name: 'Emoji Bot', canonicalSessionId: 'sess-emoji', avatar: '🌼' }),
  bot({ id: 'photo', name: 'Photo Bot', canonicalSessionId: 'sess-photo', avatar: 'https://example.com/face.png' })
] as BotInfo[];

function session(id: string, botId: string, title: string): SessionSummary {
  return {
    id,
    title,
    agentId: botId,
    metadata: { botId, canonicalBotChat: true }
  } as SessionSummary;
}

function rowProps(entry: BotInfo, selected = false) {
  return {
    session: session(entry.canonicalSessionId!, entry.id, entry.name),
    bots: roster,
    question: '你好',
    selected,
    checked: false,
    selectMode: false,
    deleting: false,
    status: null,
    onOpen() {},
    onToggleChecked() {}
  };
}

const plainSession = { id: 'plain-1', title: '普通会话', agentId: 'general' } as SessionSummary;

function renderList() {
  return renderToStaticMarkup(
    React.createElement(
      BotFaceCatalog,
      { bots: roster },
      ...roster.map((entry) =>
        React.createElement(SessionListRow, {
          key: entry.id,
          ...rowProps(entry, entry.id === 'circle')
        })
      ),
      React.createElement(SessionListRow, {
        key: 'plain',
        session: plainSession,
        bots: roster,
        question: '',
        selected: false,
        checked: false,
        selectMode: false,
        deleting: false,
        status: null,
        onOpen() {},
        onToggleChecked() {}
      })
    )
  );
}

function listRows(html: string): string[] {
  return html.split(/(?=<div class="list-item )/).filter((part) => part.startsWith('<div'));
}

function rowNamed(html: string, name: string): string {
  const found = listRows(html).find((row) => row.includes(`>${name}<`));
  assert.ok(found, `missing row ${name}`);
  return found!;
}

function svgByShape(row: string, shape: string): string {
  const found = [...row.matchAll(/<svg\b[\s\S]*?<\/svg>/g)].map((match) => match[0]).filter((svg) => svg.includes(`data-bot-shape="${shape}"`));
  assert.equal(found.length, 1, `${shape} svg count ${found.length}`);
  return found[0]!;
}

type Ink = { w: number; h: number; mask: Uint8Array; white: number; whiteBox: { minX: number; minY: number; maxX: number; maxY: number } | null };

async function inkOf(svg: string): Promise<Ink> {
  const sized = svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" ');
  const { data, info } = await sharp(Buffer.from(sized)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = 0;
  let maxY = 0;
  let white = 0;
  let wMinX = info.width;
  let wMinY = info.height;
  let wMaxX = 0;
  let wMaxY = 0;
  const mask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * 4;
      if (data[i + 3] <= 40) continue;
      mask[y * info.width + x] = 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (data[i] > 220 && data[i + 1] > 220 && data[i + 2] > 220) {
        white += 1;
        wMinX = Math.min(wMinX, x);
        wMinY = Math.min(wMinY, y);
        wMaxX = Math.max(wMaxX, x);
        wMaxY = Math.max(wMaxY, y);
      }
    }
  }
  return {
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    mask,
    white,
    whiteBox: white > 0 ? { minX: wMinX, minY: wMinY, maxX: wMaxX, maxY: wMaxY } : null
  };
}

function maskDiff(a: Uint8Array, b: Uint8Array): number {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
  return diff;
}

function rowTitle(shape: string): string {
  if (shape === 'heart') return 'Heart Bot';
  if (shape === 'cloud') return 'Cloud Bot';
  if (shape === 'flower') return 'Flower Bot';
  if (shape === 'bean') return 'Bean Bot';
  if (shape === 'circle') return 'Circle Bot';
  return `${shape} Bot`;
}

function ruleBody(css: string, selector: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[}\\n])([^@{}\\n]*${escaped}[^@{}\\n]*)\\{([^}]*)\\}`, 'g');
  const bodies: string[] = [];
  for (const match of source.matchAll(re)) {
    const selectors = match[1] ?? '';
    if (!selectors.split(',').some((part) => part.trim() === selector || part.trim().endsWith(` ${selector}`))) continue;
    bodies.push(match[2] ?? '');
  }
  assert.ok(bodies.length > 0, `missing rule ${selector}`);
  return bodies.join('\n');
}

function decl(body: string, prop: string): string {
  const match = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'));
  assert.ok(match, `missing ${prop}`);
  return match[1]!.trim();
}

function px(body: string, prop: string): number {
  const value = decl(body, prop);
  const match = value.match(/^(\d+(?:\.\d+)?)px$/);
  assert.ok(match, `${prop} should be px, got ${value}`);
  return Number(match[1]);
}

const styles = readFileSync(new URL('../legacy-vanilla/styles.css', import.meta.url), 'utf8');
const faceCss = readFileSync(new URL('./bot-face.css', import.meta.url), 'utf8');

test('心形不被拉成圆形的外框，圆形脸不缩小 [AC:bot-list-face-plate#AC-1]', async () => {
  const html = renderList();
  const heartSvg = svgByShape(rowNamed(html, 'Heart Bot'), 'heart');
  const circleSvg = svgByShape(rowNamed(html, 'Circle Bot'), 'circle');
  const heart = await inkOf(heartSvg);
  const circle = await inkOf(circleSvg);
  assert.match(circleSvg, /<circle\b[^>]*\sr="26"/);
  assert.equal(circle.w, 52, `circle width shrank to ${circle.w}`);
  assert.equal(circle.h, 52, `circle height shrank to ${circle.h}`);
  assert.ok(heart.w < circle.w - 4, `heart width ${heart.w} was stretched toward circle ${circle.w}`);
  assert.ok(heart.h < circle.h - 4, `heart height ${heart.h} was stretched toward circle ${circle.h}`);
  assert.doesNotMatch(heartSvg, /scale\(/);
  assert.doesNotMatch(circleSvg, /scale\(/);
});

test('云朵六边形水滴保持原比例，Super Bot 用上一版豆形 [AC:bot-list-face-plate#AC-2]', async () => {
  const html = renderList();
  const circle = await inkOf(svgByShape(rowNamed(html, 'Circle Bot'), 'circle'));
  const cloudSvg = svgByShape(rowNamed(html, 'Cloud Bot'), 'cloud');
  const flowerSvg = svgByShape(rowNamed(html, 'Flower Bot'), 'flower');
  const beanSvg = svgByShape(rowNamed(html, 'Bean Bot'), 'bean');
  const hexSvg = svgByShape(rowNamed(html, 'hexagon Bot'), 'hexagon');
  const dropSvg = svgByShape(rowNamed(html, 'teardrop Bot'), 'teardrop');
  const superSvg = svgByShape(rowNamed(html, 'Super Bot'), 'bean');
  const cloud = await inkOf(cloudSvg);
  const hex = await inkOf(hexSvg);
  const drop = await inkOf(dropSvg);
  assert.ok(cloud.w > cloud.h + 4, `cloud was stretched to ${cloud.w}x${cloud.h}`);
  assert.ok(hex.h > hex.w + 4, `hexagon was squashed to ${hex.w}x${hex.h}`);
  assert.ok(drop.h > drop.w + 4, `teardrop was stretched to ${drop.w}x${drop.h}`);
  for (const [name, svg] of [
    ['cloud', cloudSvg],
    ['flower', flowerSvg],
    ['bean', beanSvg],
    ['hexagon', hexSvg],
    ['teardrop', dropSvg]
  ] as const) {
    const ink = await inkOf(svg);
    assert.ok(maskDiff(ink.mask, circle.mask) >= 150, `${name} collapsed toward a circle`);
    assert.doesNotMatch(svg, /scale\(/);
  }
  assert.match(cloudSvg, /<ellipse\b/);
  assert.ok((flowerSvg.match(/<circle\b/g) ?? []).length >= 5, 'flower lost its petals');
  assert.match(hexSvg, /M32 6 54 18 54 46 32 58 10 46 10 18Z/);
  assert.match(dropSvg, /M32 6C46 18 56 32 56 42/);
  assert.match(beanSvg, /M18 28c-8 2-10 14-4 18/);
  assert.equal(beanSvg.includes('M34 7C50 8'), false);
  assert.match(superSvg, /M18 28c-8 2-10 14-4 18/);
  assert.equal(superSvg.includes('M34 7C50 8'), false);
  assert.match(superSvg, /#1AAE9F/i);
  const { BotFace } = loadFile(new URL('./BotFace.tsx', import.meta.url)) as {
    BotFace: React.ComponentType<{ name?: string; shape?: string; color?: string }>;
  };
  const pickerBean = renderToStaticMarkup(React.createElement(BotFace, { name: '', shape: 'bean', color: 'teal' }));
  assert.match(pickerBean, /M18 28c-8 2-10 14-4 18/);
  assert.equal(pickerBean.includes('M34 7C50 8'), false);
  assert.equal(pickerBean.includes('session-item__face-plate'), false);
});

test('列表头像没有圆角外框，选中也不给 icon 加框 [AC:bot-list-face-plate#AC-3]', () => {
  const html = renderList();
  const heart = rowNamed(html, 'Heart Bot');
  const circle = rowNamed(html, 'Circle Bot');
  assert.equal(heart.includes(' selected'), false);
  assert.match(circle, /class="[^"]*\bselected\b/);
  assert.equal(html.includes('session-item__face-plate'), false);
  assert.equal(html.includes('data-bot-face-plate'), false);
  assert.equal(styles.includes('session-item__face-plate'), false);
  const face = ruleBody(faceCss, '.bot-face');
  assert.equal(px(face, 'width'), px(face, 'height'));
  const slot = ruleBody(styles, '.session-item__face');
  assert.doesNotMatch(slot, /(?:width|height)\s*:/);
  assert.doesNotMatch(styles, /\.selected[^{]*session-item__face[^{]*\{[^}]*(?:width|height)\s*:/);
});

test('心形仍是心形，圆形仍是圆形，颜色仍是各自的 [AC:bot-list-face-plate#AC-4]', () => {
  const html = renderList();
  const heart = svgByShape(rowNamed(html, 'Heart Bot'), 'heart');
  const circle = svgByShape(rowNamed(html, 'Circle Bot'), 'circle');
  assert.match(heart, /data-bot-shape="heart"/);
  assert.match(heart, /data-bot-color="red"/);
  assert.match(heart, new RegExp(`fill="${BOT_FACE_SWATCH.red}"`, 'i'));
  assert.match(heart, /M32 54/);
  assert.match(circle, /data-bot-shape="circle"/);
  assert.match(circle, /data-bot-color="blue"/);
  assert.match(circle, new RegExp(`fill="${BOT_FACE_SWATCH.blue}"`, 'i'));
  assert.match(circle, /<circle\b[^>]*\sr="26"/);
  assert.equal(heart.includes(BOT_FACE_SWATCH.blue), false);
  assert.equal(circle.includes('M32 54'), false);
});

test('眼睛和嘴巴留在脸形里，名字不被挡住，不同脸的行一样高 [AC:bot-list-face-plate#AC-5]', async () => {
  const html = renderList();
  const slot = ruleBody(styles, '.session-item__face');
  assert.doesNotMatch(slot, /overflow\s*:\s*hidden/);
  assert.doesNotMatch(slot, /(?:width|height)\s*:/);
  const face = ruleBody(faceCss, '.bot-face');
  assert.equal(px(face, 'width'), px(face, 'height'));
  for (const name of ['Heart Bot', 'Circle Bot', 'Cloud Bot', 'Bean Bot', 'Super Bot']) {
    const row = rowNamed(html, name);
    const bodyAt = row.indexOf('session-item__body');
    assert.ok(bodyAt > row.indexOf('data-bot-face-slot'));
    assert.equal(row.slice(0, bodyAt).includes(name), false, `${name} is covered by the face`);
    assert.match(row, new RegExp(`session-item__title">${name}`));
    assert.match(row, /session-item__question-text">你好/);
    const shape = name === 'Heart Bot' ? 'heart' : name === 'Circle Bot' ? 'circle' : name === 'Cloud Bot' ? 'cloud' : 'bean';
    const ink = await inkOf(svgByShape(row, shape));
    assert.ok(ink.white > 30, `${name} lost eyes or mouth (${ink.white} white px)`);
    assert.ok(ink.whiteBox);
    assert.ok(ink.whiteBox!.minX > 4 && ink.whiteBox!.minY > 4, `${name} features clipped at the top or left`);
    assert.ok(ink.whiteBox!.maxX < 60 && ink.whiteBox!.maxY < 60, `${name} features clipped at the bottom or right`);
  }
});

test('不带机器人脸的行没有头像框 [AC:bot-list-face-plate#AC-6]', () => {
  const html = renderList();
  const plain = rowNamed(html, '普通会话');
  const heart = rowNamed(html, 'Heart Bot');
  assert.equal(heart.includes('data-bot-face-plate'), false);
  assert.match(heart, /data-bot-face-slot=""/);
  assert.equal(plain.includes('data-bot-face-plate'), false);
  assert.equal(plain.includes('session-item__face'), false);
  assert.match(plain, /session-item__title">普通会话/);
});

test('图片和表情仍是原来的，也没有外框 [AC:bot-list-face-plate#AC-7]', () => {
  const html = renderList();
  const emoji = rowNamed(html, 'Emoji Bot');
  const photo = rowNamed(html, 'Photo Bot');
  const heart = rowNamed(html, 'Heart Bot');
  assert.match(emoji, /data-bot-avatar="emoji"/);
  assert.match(emoji, /🌼/);
  assert.equal(emoji.includes('data-bot-shape="heart"'), false);
  assert.equal(emoji.includes('<circle'), false);
  assert.match(photo, /data-bot-avatar="image"/);
  assert.match(photo, /src="https:\/\/example.com\/face.png"/);
  assert.equal(photo.includes('data-bot-shape='), false);
  for (const row of [emoji, photo, heart]) {
    assert.equal(row.includes('session-item__face-plate'), false);
    assert.match(row, /class="session-item__face"/);
  }
  const face = ruleBody(faceCss, '.bot-face');
  assert.equal(px(face, 'width'), 40);
  assert.equal(px(face, 'height'), 40);
});

test('待机小动作不改变脸的宽高，列表没有脸的底板 [AC:bot-list-face-plate#AC-8]', () => {
  assert.equal(styles.includes('session-item__face-plate'), false);
  assert.doesNotMatch(styles, /@keyframes[^{]*face-plate/);
  const idleStart = faceCss.indexOf('@keyframes bot-face-idle-body');
  const idleEnd = faceCss.indexOf('@keyframes', idleStart + 10);
  const idle = faceCss.slice(idleStart, idleEnd > idleStart ? idleEnd : undefined);
  assert.match(idle, /transform/);
  assert.doesNotMatch(idle, /(?:^|[^-])(?:width|height)\s*:/);
  const face = ruleBody(faceCss, '.bot-face');
  assert.equal(px(face, 'width'), px(face, 'height'));
  assert.doesNotMatch(ruleBody(styles, '.session-item__face'), /(?:width|height)\s*:/);
});
