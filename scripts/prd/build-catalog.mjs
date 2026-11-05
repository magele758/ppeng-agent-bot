#!/usr/bin/env node
/**
 * Project acceptance specs and repo skills into the product PRD catalog.
 * This script is the only writer of the generated catalog files.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec } from '../acceptance/acceptance-lib.mjs';
import { writeTraceAndCoreCases } from './trace-model.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATED = '<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->';
const STATUS_LABEL = { draft: '草稿', approved: '已批准未实现' };

function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function posixRel(full) {
  return relative(root, full).split(sep).join('/');
}

function finish(lines) {
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function prefixOf(id) {
  const dash = id.indexOf('-');
  return dash === -1 ? 'other' : id.slice(0, dash);
}

/** A prefix page is worth it only when it holds enough features to scan. */
const MIN_PREFIX_PAGE = 4;

function fileForPrefix(prefix, count) {
  if (prefix === 'index' || prefix === 'other' || count < MIN_PREFIX_PAGE) return 'other';
  return prefix;
}

function listYamlSpecs() {
  const dir = join(root, 'acceptance');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .map((entry) => entry.name)
    .sort(cmp);
}

function listSkillFiles(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === 'SKILL.md') found.push(full);
    }
  }
  return found;
}

function frontmatterBlock(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') return { error: 'missing opening frontmatter' };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return { block: lines.slice(1, i).join('\n') };
  }
  return { error: 'unclosed frontmatter' };
}

function unquote(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

function blockValue(lines, indicator) {
  const fold = indicator.startsWith('>');
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    min = Math.min(min, line.match(/^[ \t]*/)[0].length);
  }
  const body = lines.map((line) => (line.trim() === '' || !Number.isFinite(min) ? '' : line.slice(min)));
  const text = body.join('\n').trim();
  if (!fold) return text;
  return text.split(/\n{2,}/).map((part) => part.replace(/\n/g, ' ').replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n\n');
}

function frontmatterFields(block) {
  const lines = block.split('\n');
  const fields = {};
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '' || line.startsWith(' ') || line.startsWith('\t') || line.startsWith('#') || line.startsWith('-')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    if (seen.has(key)) return { error: `duplicate frontmatter key ${key}` };
    seen.add(key);
    const raw = line.slice(colon + 1).trim();
    if (raw === '|' || raw === '|-' || raw === '|+' || raw === '>' || raw === '>-' || raw === '>+') {
      const body = [];
      while (i + 1 < lines.length && (lines[i + 1] === '' || lines[i + 1].startsWith(' ') || lines[i + 1].startsWith('\t'))) {
        i++;
        body.push(lines[i]);
      }
      fields[key] = blockValue(body, raw);
    } else fields[key] = unquote(raw).trim();
  }
  return { fields };
}

function readSkill(full) {
  const where = posixRel(full);
  const split = frontmatterBlock(readFileSync(full, 'utf8'));
  if (split.error) return { error: `${where}: ${split.error}` };
  const parsed = frontmatterFields(split.block);
  if (parsed.error) return { error: `${where}: ${parsed.error}` };
  const name = parsed.fields.name ?? '';
  const description = parsed.fields.description ?? '';
  const missing = [];
  if (!name) missing.push('name');
  if (!description) missing.push('description');
  if (missing.length) return { error: `${where}: missing ${missing.join(' and ')}` };
  return { skill: { name, description, path: where } };
}

function loadInputs() {
  const errors = [];
  const specs = [];
  for (const name of listYamlSpecs()) {
    const parsed = parseSpec(readFileSync(join(root, 'acceptance', name), 'utf8'), name);
    if (parsed.errors.length || !parsed.spec) {
      errors.push(...(parsed.errors.length ? parsed.errors : [`acceptance/${name}: parseSpec returned no spec`]));
      continue;
    }
    specs.push(parsed.spec);
  }
  const skillsDir = join(root, 'skills');
  const skills = [];
  if (!existsSync(skillsDir)) errors.push('skills: directory not found');
  else {
    for (const full of listSkillFiles(skillsDir)) {
      const read = readSkill(full);
      if (read.error) errors.push(read.error);
      else skills.push(read.skill);
    }
  }
  return { errors, specs, skills };
}

function partition(specs) {
  const counts = { implemented: 0, approved: 0, draft: 0, retired: 0 };
  const shipped = [];
  const pending = [];
  const retired = [];
  for (const spec of specs) {
    counts[spec.status] += 1;
    if (spec.status === 'implemented') shipped.push(spec);
    else if (spec.status === 'draft' || spec.status === 'approved') pending.push(spec);
    else retired.push(spec);
  }
  shipped.sort((a, b) => cmp(a.id, b.id));
  pending.sort((a, b) => cmp(a.status, b.status) || cmp(a.id, b.id));
  retired.sort((a, b) => cmp(a.id, b.id));
  return { counts, shipped, pending, retired };
}

function prefixesOf(shipped) {
  const map = new Map();
  for (const spec of shipped) {
    const name = prefixOf(spec.id);
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(spec);
  }
  return [...map.entries()].sort((a, b) => cmp(a[0], b[0]));
}

function buildGroups(shipped) {
  const counts = new Map(prefixesOf(shipped).map(([name, specs]) => [name, specs.length]));
  const map = new Map();
  for (const spec of shipped) {
    const name = fileForPrefix(prefixOf(spec.id), counts.get(prefixOf(spec.id)));
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(spec);
  }
  return [...map.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([name, specs]) => ({ name, specs }));
}

function catalogOf({ counts, shipped, pending, retired, skills }) {
  return {
    generatedFrom: 'acceptance/*.yaml + skills/**/SKILL.md',
    counts,
    shipped: shipped.map((spec) => ({
      id: spec.id,
      title: spec.title,
      requirement: spec.requirement.trim(),
      verificationStage: spec.verificationStage,
      file: spec.file,
    })),
    pending: pending.map((spec) => ({
      id: spec.id,
      title: spec.title,
      status: spec.status,
      requirement: spec.requirement.trim(),
      verificationStage: spec.verificationStage,
      file: spec.file,
    })),
    retired: retired.map((spec) => ({
      id: spec.id,
      title: spec.title,
      retiredReason: spec.retiredReason ?? '',
      file: spec.file,
    })),
    skills,
  };
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function renderIndex(shipped) {
  const prefixes = prefixesOf(shipped);
  const lines = [
    GENERATED,
    '',
    '# 已经开发的功能',
    '',
    `已实现 ${shipped.length} 条。每条对上一条已经实现的验收规格：名称在下面，用户需求在对应分页。满 ${MIN_PREFIX_PAGE} 条的前缀单独成页，其余收在 [other](other.md)。`,
    '',
  ];
  for (const [prefix, specs] of prefixes) {
    const file = fileForPrefix(prefix, specs.length);
    lines.push(`## ${prefix}（${specs.length}）`, '', `需求正文见 [${file}](${file}.md)。`, '');
    for (const spec of specs) lines.push(`- \`${spec.id}\` ${oneLine(spec.title)}`);
    lines.push('');
  }
  return finish(lines);
}

function renderShippedGroup(specs) {
  const lines = [GENERATED, ''];
  for (const spec of specs) {
    lines.push(`## ${spec.id}`, spec.title, '', spec.requirement.trim(), '');
  }
  return finish(lines);
}

function criterionLines(criterion) {
  const lines = [`- ${criterion.id}`];
  for (const field of ['given', 'when', 'then']) {
    const [first, ...rest] = String(criterion[field] ?? '').trim().split('\n');
    lines.push(`  - ${field}: ${first ?? ''}`);
    for (const extra of rest) lines.push(`    ${extra}`);
  }
  return lines;
}

function renderBacklog(pending, retired) {
  const lines = [
    GENERATED,
    '',
    '# 尚未实现的验收规格',
    '',
    '下面是草稿，以及已批准但还没有实现的验收规格。已经实现的规格不在这里。',
    '',
  ];
  if (!pending.length) lines.push('当前没有尚未实现的验收规格。', '');
  for (const spec of pending) {
    lines.push(`## ${spec.id}`, '', `状态：${STATUS_LABEL[spec.status]}`, '', spec.title, '', spec.requirement.trim(), '');
    for (const criterion of spec.criteria) lines.push(...criterionLines(criterion));
    lines.push('');
  }
  lines.push('# 已取消，不是待开发', '', '这些规格已经取消，不是待开发。', '');
  if (!retired.length) lines.push('当前没有已取消的验收规格。', '');
  for (const spec of retired) {
    lines.push(`## ${spec.id}`, '', spec.title, '');
    if (spec.retiredReason) lines.push(spec.retiredReason, '');
  }
  return finish(lines);
}

function mdCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function renderSkills(skills) {
  const lines = [
    GENERATED,
    '',
    '# 仓库技能对照',
    '',
    '用途以各技能文件的 description 为准，本页只是投影。',
    '',
    '| 名称 | 用途 | 路径 |',
    '| --- | --- | --- |',
  ];
  for (const skill of skills) lines.push(`| ${mdCell(skill.name)} | ${mdCell(skill.description)} | ${mdCell(skill.path)} |`);
  return finish(lines);
}

function writeCatalog(catalog, groups, pending, retired, skills) {
  const prd = join(root, 'doc/prd');
  const shippedDir = join(prd, 'shipped');
  mkdirSync(shippedDir, { recursive: true });
  mkdirSync(join(prd, 'backlog'), { recursive: true });
  mkdirSync(join(prd, 'current'), { recursive: true });
  if (groups.some((group) => group.name === 'index')) {
    console.error('group name "index" collides with doc/prd/shipped/index.md');
    process.exit(1);
  }
  const keep = new Set(['index.md']);
  for (const group of groups) {
    keep.add(`${group.name}.md`);
    writeFileSync(join(shippedDir, `${group.name}.md`), renderShippedGroup(group.specs));
  }
  writeFileSync(join(shippedDir, 'index.md'), renderIndex(catalog.shipped.map((entry) => ({ id: entry.id, title: entry.title }))));
  for (const name of readdirSync(shippedDir)) {
    if (name.endsWith('.md') && !keep.has(name)) rmSync(join(shippedDir, name));
  }
  writeFileSync(join(prd, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(join(prd, 'backlog/from-acceptance.md'), renderBacklog(pending, retired));
  writeFileSync(join(prd, 'current/skills.md'), renderSkills(skills));
}

const { errors, specs, skills } = loadInputs();
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
skills.sort((a, b) => cmp(a.path, b.path));
const { counts, shipped, pending, retired } = partition(specs);
const groups = buildGroups(shipped);
writeCatalog(catalogOf({ counts, shipped, pending, retired, skills }), groups, pending, retired, skills);
const traceErrors = writeTraceAndCoreCases(root, specs);
if (traceErrors.length) {
  for (const error of traceErrors) console.error(error);
  process.exit(1);
}
console.log(`implemented ${counts.implemented}, approved ${counts.approved}, draft ${counts.draft}, retired ${counts.retired}, skills ${skills.length}`);
