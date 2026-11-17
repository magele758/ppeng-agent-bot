import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCoreCases } from './core-cases-plan.mjs';
import { findJourneys, validateLocations } from './feature-map-model.mjs';

const root = resolve(import.meta.dirname, '../..');
const { values, positionals } = parseArgs({
  options: { json: { type: 'boolean' }, core: { type: 'boolean' } }, allowPositionals: true
});
const { cases } = loadCoreCases(root);
validateLocations(root, cases);
const query = positionals.join(' ').toLowerCase().trim();
const selected = findJourneys(cases, query);
const trace = JSON.parse(readFileSync(join(root, 'doc/prd/trace.json'), 'utf8'));
const bySpec = new Map([...trace.chapters.flatMap(chapter => chapter.specs), ...trace.unassigned].map(row => [row.id, row]));
const journeys = selected.map(item => {
  const files = item.specs.flatMap(id => {
    const row = bySpec.get(id);
    if (!row?.tests.length) throw new Error('Missing test mapping for ' + id + '. Run node scripts/prd/build-catalog.mjs');
    return row.tests;
  });
  return {
    kind: 'journey', id: item.id, title: item.title, route: item.route, aliases: item.aliases, sources: item.sources,
    chapters: item.chapters.map(name => 'doc/prd/current/' + name + '.md'),
    acceptance: item.specs.map(id => 'acceptance/' + id + '.yaml'),
    tests: [...new Set(files)].sort(), regression: 'node scripts/prd/core-cases.mjs --case ' + item.id,
    exploration: item.exploration ? 'pnpm run ' + item.exploration : null
  };
});
const catalog = JSON.parse(readFileSync(join(root, 'doc/prd/catalog.json'), 'utf8'));
// Keep the document list in sync with product books, including nested proposals.
const chapterTitles = new Map(trace.chapters.map(chapter => [chapter.file, chapter.title]));
const documents = [];
for (const directory of ['doc/prd', 'doc/bot']) {
  const names = readdirSync(join(root, directory), { recursive: true })
    .filter(name => name.endsWith('.md')).sort();
  for (const name of names) {
    const path = join(directory, name).split(sep).join('/');
    const heading = readFileSync(join(root, path), 'utf8').match(/^# (.+)$/m);
    documents.push({ kind: 'document', title: chapterTitles.get(path) ?? heading?.[1] ?? name, path });
  }
}

const chaptersBySpec = new Map();
for (const chapter of trace.chapters) {
  for (const spec of chapter.specs) {
    const paths = chaptersBySpec.get(spec.id) ?? [];
    paths.push(chapter.file);
    chaptersBySpec.set(spec.id, paths);
  }
}
function specEntry(spec, status) {
  return { kind: 'spec', id: spec.id, title: spec.title, status,
    requirement: spec.requirement ?? spec.retiredReason, acceptance: [spec.file],
    chapters: chaptersBySpec.get(spec.id) ?? [], tests: bySpec.get(spec.id)?.tests ?? [] };
}
const specs = [
  ...catalog.shipped.map(spec => specEntry(spec, 'implemented')),
  ...catalog.pending.map(spec => specEntry(spec, spec.status)),
  ...catalog.retired.map(spec => specEntry(spec, 'retired'))
];
function matches(fields) {
  return fields.some(field => field?.toLowerCase().includes(query));
}
const exactSpecs = specs.filter(spec => spec.id === query);
const found = values.core ? journeys : [
  ...exactSpecs, ...journeys,
  ...documents.filter(doc => matches([doc.title, doc.path])),
  ...specs.filter(spec => spec.id !== query && matches([spec.id, spec.title, spec.requirement]))
];
function printEntry(item) {
  if (item.kind === 'document') return console.log(item.title, item.path);
  if (item.kind === 'spec') {
    console.log(item.status, item.id, item.title, item.acceptance[0]);
    if (item.chapters.length) console.log('  产品章节', item.chapters.join(', '));
    if (item.tests.length) console.log('  测试', item.tests.join(', '));
    return;
  }
  console.log(item.id, item.route, item.title);
  if (query) {
    console.log('  实现', item.sources.join(', '));
    console.log('  规格', item.acceptance.join(', '));
    console.log('  测试', item.tests.join(', '));
    console.log('  回归', item.regression);
    if (item.exploration) console.log('  探索', item.exploration);
  }
}
if (values.json) console.log(JSON.stringify(found, null, 2));
else if (query || values.core) found.forEach(printEntry);
else {
  documents.forEach(printEntry);
  console.log('\n验收规格', catalog.counts);
  console.log('按功能名、需求用语或规格 ID 查询。--json 列出全量条目，--core 只列核心回归流程。');
}
if (!found.length) {
  console.error('没有匹配项。完整产品目录见 doc/prd/README.md。');
  process.exitCode = 1;
}
