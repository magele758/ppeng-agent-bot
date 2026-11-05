/**
 * Joins the seven current chapters to implemented specs and the tests that tag them.
 * build-catalog.mjs is the only caller that writes the generated pages.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCoreCases, validateCoreCases } from './core-cases-plan.mjs';
import { indexActiveTests } from './test-index.mjs';

const GENERATED = '<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格、现状章节的依据或核心用例后重新运行该脚本。 -->';

function unquote(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

function frontmatterTitle(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') return '';
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const match = /^title:\s*(.*)$/.exec(lines[i]);
    if (match) return unquote(match[1].trim());
  }
  return '';
}

export function citedBotChapters(markdown, fromFile) {
  const fromDir = fromFile.split('/').slice(0, -1).join('/');
  const found = new Set();
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let href = match[1].trim();
    if (href.startsWith('<')) {
      const end = href.indexOf('>');
      href = end === -1 ? href.slice(1) : href.slice(1, end);
    }
    href = href.split(/\s+/)[0].split('#')[0].split('?')[0];
    if (!href || href.startsWith('http:') || href.startsWith('https:') || href.startsWith('/')) continue;
    const rel = normalizePosix(`${fromDir}/${href}`);
    if (/^doc\/bot\/0[1-9]-[^/]+\.md$/.test(rel)) found.add(rel);
  }
  return [...found].sort();
}

function normalizePosix(value) {
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function specIdsInBackticks(markdown, known) {
  const found = [];
  const seen = new Set();
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const id = match[1].trim();
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    found.push(id);
  }
  return found;
}

function currentChapters(root) {
  const dir = join(root, 'doc/prd/current');
  return readdirSync(dir)
    .filter((name) => /^0[1-9]-.+\.md$/.test(name))
    .sort()
    .map((name) => {
      const file = `doc/prd/current/${name}`;
      const text = readFileSync(join(root, file), 'utf8');
      return { file, title: frontmatterTitle(text) || name.replace(/\.md$/, ''), text };
    });
}

export function buildTrace(root, specs, testsBySpec) {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const known = new Set(byId.keys());
  const chapters = [];
  const assigned = new Set();
  for (const chapter of currentChapters(root)) {
    const botChapters = citedBotChapters(chapter.text, chapter.file);
    for (const bot of botChapters) {
      if (!existsSync(join(root, bot))) throw new Error(`missing cited chapter ${bot} from ${chapter.file}`);
    }
    const named = new Set();
    for (const bot of botChapters) {
      for (const id of specIdsInBackticks(readFileSync(join(root, bot), 'utf8'), known)) named.add(id);
    }
    const rows = [];
    for (const id of [...named].sort()) {
      const spec = byId.get(id);
      if (spec.status !== 'implemented') continue;
      assigned.add(id);
      rows.push({ id, title: spec.title, tests: testsBySpec.get(id) ?? [] });
    }
    chapters.push({ file: chapter.file, title: chapter.title, botChapters, specs: rows });
  }
  const unassigned = specs
    .filter((spec) => spec.status === 'implemented' && !assigned.has(spec.id))
    .map((spec) => ({ id: spec.id, title: spec.title, tests: testsBySpec.get(spec.id) ?? [] }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { chapters, unassigned };
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function renderRows(rows, lines) {
  for (const row of rows) {
    lines.push(`### ${row.id}`, '', oneLine(row.title), '');
    if (!row.tests.length) lines.push('没有带验收标签的测试。', '');
    else for (const file of row.tests) lines.push(`- \`${file}\``);
    lines.push('');
  }
}

function renderTrace(trace) {
  const lines = [
    GENERATED,
    '',
    '# 现状章节与验收对照',
    '',
    '每一章只列出它点名、并且已经实现的规格，以及标题里带有该规格验收标签的测试。草稿、已批准未实现、已取消，和还没有规格的方向，不记为已覆盖。一条规格可以出现在多章里。',
    '',
  ];
  for (const chapter of trace.chapters) {
    lines.push(`## ${chapter.title}`, '', `现状：\`${chapter.file}\``, '');
    if (chapter.botChapters.length) {
      lines.push(`点名来自：${chapter.botChapters.map((file) => `\`${file}\``).join('、')}`, '');
    }
    if (!chapter.specs.length) lines.push('这一章没有点名已经实现的规格。', '');
    renderRows(chapter.specs, lines);
  }
  lines.push('## 没有被现状章节点名的已实现规格', '');
  if (!trace.unassigned.length) lines.push('当前没有这样的规格。', '');
  renderRows(trace.unassigned, lines);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function chapterTitle(root, stem) {
  const file = join(root, 'doc/prd/current', `${stem}.md`);
  if (!existsSync(file)) return stem;
  return frontmatterTitle(readFileSync(file, 'utf8')) || stem;
}

function renderCoreCases(root, doc, specsById) {
  const lines = [
    GENERATED,
    '',
    '# 核心用例',
    '',
    doc.note,
    '',
    '这些是人能走完的路径。每条只点名已经实现、并且已有测试的功能。只跑这些测试：',
    '',
    '```bash',
    'node scripts/prd/core-cases.mjs --list',
    'node scripts/prd/core-cases.mjs',
    '```',
    '',
  ];
  for (const item of doc.cases) {
    lines.push(`## ${item.title}`, '', `\`${item.id}\``, '');
    if (item.chapters.length) {
      const links = item.chapters.map((stem) => `[${chapterTitle(root, stem)}](current/${stem}.md)`);
      lines.push(`对应现状：${links.join('、')}`, '');
    }
    for (const id of item.specs) {
      const title = specsById.get(id)?.title ?? '';
      lines.push(`- \`${id}\` ${oneLine(title)}`.trimEnd());
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function writeTraceAndCoreCases(root, specs) {
  const errors = [];
  let doc;
  try {
    doc = loadCoreCases(root);
  } catch (error) {
    return [error.message];
  }
  for (const item of doc.cases) {
    for (const stem of item.chapters) {
      if (!/^0[1-9]-[a-z0-9-]+$/.test(stem) || !existsSync(join(root, 'doc/prd/current', `${stem}.md`))) {
        errors.push(`${item.id || '(missing id)'} cites missing chapter ${stem}`);
      }
    }
  }
  let indexed;
  try {
    indexed = indexActiveTests(root);
  } catch (error) {
    return [...errors, error.message];
  }
  const specsById = new Map(specs.map((spec) => [spec.id, spec]));
  const checked = validateCoreCases(doc.cases, { specsById, testsBySpec: indexed.testsBySpec });
  if (!checked.ok) errors.push(...checked.errors);
  let trace;
  try {
    trace = buildTrace(root, specs, indexed.testsBySpec);
  } catch (error) {
    return [...errors, error.message];
  }
  for (const row of [...trace.chapters.flatMap((chapter) => chapter.specs), ...trace.unassigned]) {
    if (!row.tests.length) errors.push(`${row.id} is implemented but has no active tagged test`);
  }
  if (errors.length) return errors;
  const prd = join(root, 'doc/prd');
  const body = {
    generatedFrom: 'doc/prd/current chapters → doc/bot/01-09 + acceptance status + runnable tests',
    chapters: trace.chapters,
    unassigned: trace.unassigned,
  };
  writeFileSync(join(prd, 'trace.json'), `${JSON.stringify(body, null, 2)}\n`);
  writeFileSync(join(prd, 'trace.md'), renderTrace(trace));
  writeFileSync(join(prd, 'core-cases.md'), renderCoreCases(root, doc, specsById));
  return [];
}
