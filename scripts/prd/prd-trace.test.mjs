import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseSpec, scanTestSource } from '../acceptance/acceptance-lib.mjs';
import { loadCoreCases, validateCoreCases } from './core-cases-plan.mjs';
import { indexActiveTests, loadSpecs } from './test-index.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function readRepo(rel) {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function buildCatalog() {
  const result = spawnSync(process.execPath, ['scripts/prd/build-catalog.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message || 'build-catalog failed');
}

/** Independent of the generator. Chapter links resolve only into Bot chapters 01–09. */
function citedBotChapters(markdown, fromFile) {
  const fromDir = path.posix.dirname(fromFile);
  const found = new Set();
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let href = match[1].trim();
    if (href.startsWith('<')) {
      const end = href.indexOf('>');
      href = end === -1 ? href.slice(1) : href.slice(1, end);
    }
    href = href.split(/\s+/)[0].split('#')[0].split('?')[0];
    if (!href || href.startsWith('http:') || href.startsWith('https:') || href.startsWith('/')) continue;
    const rel = path.posix.normalize(path.posix.join(fromDir, href));
    if (/^doc\/bot\/0[1-9]-[^/]+\.md$/.test(rel)) found.add(rel);
  }
  return [...found].sort();
}

function implementedIdsNamedBy(markdown, implementedIds) {
  const found = new Set();
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const id = match[1].trim();
    if (implementedIds.has(id)) found.add(id);
  }
  return found;
}

function expectedChapterSets(specs) {
  const implementedIds = new Set(specs.filter((spec) => spec.status === 'implemented').map((spec) => spec.id));
  const dir = path.join(repoRoot, 'doc/prd/current');
  const files = readdirSync(dir).filter((name) => /^0[1-9]-.+\.md$/.test(name)).sort();
  const chapters = [];
  const assigned = new Set();
  for (const name of files) {
    const file = `doc/prd/current/${name}`;
    const named = new Set();
    for (const bot of citedBotChapters(readRepo(file), file)) {
      for (const id of implementedIdsNamedBy(readRepo(bot), implementedIds)) named.add(id);
    }
    for (const id of named) assigned.add(id);
    chapters.push({ file, ids: [...named].sort() });
  }
  const unassigned = [...implementedIds].filter((id) => !assigned.has(id)).sort();
  return { chapters, unassigned };
}

function coveredIds(trace) {
  const ids = [];
  for (const chapter of trace.chapters) for (const spec of chapter.specs) ids.push(spec.id);
  for (const spec of trace.unassigned) ids.push(spec.id);
  return ids;
}

function assertActiveTag(file, id) {
  const hits = scanTestSource(readRepo(file), file).filter((hit) => hit.active);
  assert.ok(
    hits.some((hit) => hit.tags.some((tag) => tag.featureId === id && !tag.error)),
    `${file} has no active acceptance tag for ${id}`,
  );
}

describe('产品需求与测试对照', { concurrency: 1 }, () => {
  test('对照表列出章节点名的已实现规格和测试 [AC:prd-test-trace#AC-1]', () => {
    buildCatalog();
    const trace = JSON.parse(readRepo('doc/prd/trace.json'));
    const page = readRepo('doc/prd/trace.md');
    const specs = loadSpecs(repoRoot);
    const expected = expectedChapterSets(specs);
    assert.deepEqual(trace.chapters.map((chapter) => chapter.file), expected.chapters.map((chapter) => chapter.file));
    for (let i = 0; i < expected.chapters.length; i++) {
      assert.deepEqual(
        trace.chapters[i].specs.map((spec) => spec.id),
        expected.chapters[i].ids,
        trace.chapters[i].file,
      );
    }
    assert.deepEqual(trace.unassigned.map((spec) => spec.id), expected.unassigned);
    const implemented = new Set(specs.filter((spec) => spec.status === 'implemented').map((spec) => spec.id));
    const covered = coveredIds(trace);
    assert.deepEqual([...new Set(covered)].sort(), [...implemented].sort());
    const headings = new Set(page.split('\n'));
    for (const spec of [...trace.chapters.flatMap((chapter) => chapter.specs), ...trace.unassigned]) {
      assert.equal(implemented.has(spec.id), true, spec.id);
      assert.ok(spec.tests.length > 0, `${spec.id} lists no test`);
      assert.ok(headings.has(`### ${spec.id}`), `trace page missing ${spec.id}`);
      for (const file of spec.tests) assertActiveTag(file, spec.id);
    }
    for (const spec of specs) {
      if (spec.status === 'implemented') continue;
      assert.equal(headings.has(`### ${spec.id}`), false, `trace covers ${spec.status} ${spec.id}`);
    }
    assert.equal(page.includes('还不是承诺'), false);
    assert.match(page, /没有被现状章节点名的已实现规格/);
    assert.match(page, /不要手改/);
  });

  test('核心用例是八到十条已经实现且有测试的路径 [AC:prd-test-trace#AC-2]', () => {
    buildCatalog();
    const { note, cases } = loadCoreCases(repoRoot);
    const specs = new Map(loadSpecs(repoRoot).map((spec) => [spec.id, spec]));
    const tests = indexActiveTests(repoRoot).testsBySpec;
    assert.ok(cases.length >= 8 && cases.length <= 10, `core cases ${cases.length}`);
    assert.match(note, /领域包/);
    assert.match(note, /交互卡片/);
    const page = readRepo('doc/prd/core-cases.md');
    assert.match(page, /领域包/);
    assert.match(page, /不要手改/);
    const seen = new Set();
    for (const item of cases) {
      assert.equal(seen.has(item.id), false, `duplicate case ${item.id}`);
      seen.add(item.id);
      assert.ok(item.title.trim().length > 0, `${item.id} title`);
      assert.ok(item.specs.length > 0, `${item.id} names nothing`);
      assert.ok(page.includes(item.title), `core page missing ${item.title}`);
      for (const id of item.specs) {
        const spec = specs.get(id);
        assert.ok(spec, `${item.id} names unknown ${id}`);
        assert.equal(spec.status, 'implemented', `${id} is ${spec?.status}`);
        assert.ok((tests.get(id) ?? []).length > 0, `${id} has no active tagged test`);
        assert.ok(page.includes(id), `core page missing ${id}`);
      }
    }
  });

  test('核心用例命令只列出点名规格的测试，未实现或没有测试则失败 [AC:prd-test-trace#AC-3]', () => {
    const loaded = loadCoreCases(repoRoot);
    const specs = loadSpecs(repoRoot);
    const index = indexActiveTests(repoRoot);
    const plan = validateCoreCases(loaded.cases, { specsById: new Map(specs.map((spec) => [spec.id, spec])), ...index });
    assert.equal(plan.ok, true, plan.errors.join('\n'));
    assert.ok(plan.files.length > 0);
    assert.ok(plan.files.length < index.runnableCount, 'core command selected every runnable test');

    const listed = spawnSync(process.execPath, ['scripts/prd/core-cases.mjs', '--list'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.deepEqual(listed.stdout.trim().split('\n').filter(Boolean), plan.files);
    const named = new Set(loaded.cases.flatMap((item) => item.specs));
    for (const file of plan.files) {
      const hits = scanTestSource(readRepo(file), file).filter((hit) => hit.active);
      assert.ok(
        hits.some((hit) => hit.tags.some((tag) => named.has(tag.featureId) && !tag.error)),
        `${file} is not tagged for a core spec`,
      );
    }

    const approved = specs.find((spec) => spec.id === 'bot-release-readiness');
    assert.equal(approved?.status, 'approved');
    const withApproved = loaded.cases.map((item, index) => (
      index === 0 ? { ...item, specs: [...item.specs, 'bot-release-readiness'] } : item
    ));
    const rejected = validateCoreCases(withApproved, {
      specsById: new Map(specs.map((spec) => [spec.id, spec])),
      testsBySpec: index.testsBySpec,
    });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some((error) => error.includes('bot-release-readiness') && error.includes('approved')));

    const untested = new Map(index.testsBySpec);
    untested.set('bots', []);
    const missingTest = validateCoreCases(loaded.cases, {
      specsById: new Map(specs.map((spec) => [spec.id, spec])),
      testsBySpec: untested,
    });
    assert.equal(missingTest.ok, false);
    assert.ok(missingTest.errors.some((error) => error.includes('bots') && error.includes('no active tagged test')));

    const dir = mkdtempSync(path.join(tmpdir(), 'prd-core-cases-'));
    const casesFile = path.join(dir, 'cases.yaml');
    const doc = parseYaml(readRepo('doc/prd/core-cases.yaml'));
    doc.cases[0].specs = [...doc.cases[0].specs, 'bot-release-readiness'];
    writeFileSync(casesFile, stringifyYaml(doc));
    const failed = spawnSync(process.execPath, ['scripts/prd/core-cases.mjs', '--cases', casesFile, '--list'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /bot-release-readiness/);
    assert.equal(failed.stdout.includes('ok '), false);
  });
});
