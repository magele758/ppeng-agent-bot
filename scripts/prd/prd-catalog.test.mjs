import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseSpec } from '../acceptance/acceptance-lib.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const NARRATIVE_FILES = [
  'doc/prd/current/README.md',
  'doc/prd/current/01-product.md',
  'doc/prd/current/02-bots-and-workspace.md',
  'doc/prd/current/03-conversation.md',
  'doc/prd/current/04-goals-and-collaboration.md',
  'doc/prd/current/05-memory-skills-routines.md',
  'doc/prd/current/06-safety-and-runtime.md',
  'doc/prd/current/07-evolution-and-platform.md',
  'doc/prd/shipped/index.md',
  'doc/prd/backlog/README.md',
  'doc/prd/backlog/from-acceptance.md',
  'doc/prd/backlog/direction.md',
];

function readRepo(rel) {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function sorted(ids) {
  return [...ids].sort();
}

function idsOf(list, label) {
  assert.ok(Array.isArray(list), `${label} must be an array`);
  return new Set(list.map((entry, index) => {
    const id = typeof entry === 'string' ? entry : entry?.id;
    assert.equal(typeof id, 'string', `${label}[${index}] missing id`);
    assert.ok(id.trim().length > 0, `${label}[${index}] empty id`);
    return id.trim();
  }));
}

function loadSpecs() {
  const dir = path.join(repoRoot, 'acceptance');
  const names = readdirSync(dir).filter((name) => name.endsWith('.yaml')).sort();
  const specs = [];
  for (const name of names) {
    const parsed = parseSpec(readFileSync(path.join(dir, name), 'utf8'), name);
    assert.deepEqual(parsed.errors, [], parsed.errors.join('\n'));
    specs.push(parsed.spec);
  }
  return specs;
}

function buildCatalog() {
  const result = spawnSync(process.execPath, ['scripts/prd/build-catalog.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout || result.error?.message || 'build-catalog failed',
  );
  // Regenerate must be a no-op against committed docs. A dirty tree here used to
  // pass unit assertions on the rewritten files, then fail validation-lane identity.
  const dirty = spawnSync('git', ['status', '--porcelain', '--', 'doc/prd/'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(dirty.status, 0, dirty.stderr || dirty.error?.message || 'git status failed');
  assert.equal(
    dirty.stdout.trim(),
    '',
    `doc/prd generated files are stale; run: node scripts/prd/build-catalog.mjs\n${dirty.stdout}`,
  );
}

function readCatalog() {
  return JSON.parse(readRepo('doc/prd/catalog.json'));
}

/** Whole line, or h2 whose token is exactly this id. `bot` must not match `bot-room`. */
function mentionsAsLineOrH2(markdown, id) {
  const text = markdown.replaceAll('\r\n', '\n');
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^${escaped}$`, 'm').test(text)) return true;
  return new RegExp(`^##\\s+${escaped}(?![A-Za-z0-9-])`, 'm').test(text);
}

function containsIdToken(markdown, id) {
  const text = markdown.replaceAll('\r\n', '\n');
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`, 'm').test(text);
}

function isH2(markdown, id) {
  const text = markdown.replaceAll('\r\n', '\n');
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+${escaped}(?![A-Za-z0-9-])`, 'm').test(text);
}

function shippedMarkdown() {
  const dir = path.join(repoRoot, 'doc/prd/shipped');
  const names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
  assert.ok(names.length > 0, 'doc/prd/shipped has no markdown');
  return names.map((name) => readFileSync(path.join(dir, name), 'utf8')).join('\n');
}

function unquoteScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

/** `description:` lines may contain ": ", which YAML compact mappings reject. */
function parseSkillFrontmatter(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, `${file} missing frontmatter`);
  const block = match[1];
  try {
    const data = parseYaml(block);
    if (typeof data?.name === 'string' && typeof data?.description === 'string') {
      return { name: data.name.trim(), description: data.description.trim() };
    }
  } catch {
    // Fall through to the raw name / description lines.
  }
  const name = /^name:\s*(.+)\s*$/m.exec(block);
  const description = /^description:\s*(.+)\s*$/m.exec(block);
  assert.ok(name && description, `${file} frontmatter needs name and description`);
  return { name: unquoteScalar(name[1]), description: unquoteScalar(description[1]) };
}

function diskSkills() {
  const root = path.join(repoRoot, 'skills');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name === 'SKILL.md') files.push(abs);
    }
  };
  walk(root);
  return files.sort().map((abs) => {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    const frontmatter = parseSkillFrontmatter(readFileSync(abs, 'utf8'), rel);
    return { ...frontmatter, path: rel };
  });
}

function normalizeCatalogSkill(skill) {
  assert.equal(typeof skill?.name, 'string', 'catalog skill missing name');
  assert.equal(typeof skill?.description, 'string', 'catalog skill missing description');
  assert.equal(typeof skill?.path, 'string', 'catalog skill missing path');
  let rel = skill.path.replaceAll('\\', '/');
  const prefix = `${repoRoot}/`;
  if (rel.startsWith(prefix)) rel = rel.slice(prefix.length);
  if (rel.startsWith('./')) rel = rel.slice(2);
  return { name: skill.name.trim(), description: skill.description.trim(), path: rel };
}

describe('product prd catalog', { concurrency: false }, () => {
  test('产品需求目录能读到现有功能、已开发功能和待开发功能 [AC:product-prd#AC-1]', () => {
    const readme = readRepo('doc/prd/README.md');
    assert.match(readme, /\[[^\]]*\]\([^)]*current\/[^)]*\)/);
    assert.match(readme, /\[[^\]]*\]\([^)]*shipped\/[^)]*\)/);
    assert.match(readme, /\[[^\]]*\]\([^)]*backlog\/[^)]*\)/);
    for (const rel of NARRATIVE_FILES) {
      const abs = path.join(repoRoot, rel);
      assert.ok(existsSync(abs), `missing ${rel}`);
      const text = readFileSync(abs, 'utf8');
      assert.ok(text.length > 400, `${rel} length ${text.length}`);
    }
  });

  test('已开发清单只收录已经实现的验收规格 [AC:product-prd#AC-2]', () => {
    buildCatalog();
    const catalog = readCatalog();
    const specs = loadSpecs();
    const implemented = new Set(specs.filter((spec) => spec.status === 'implemented').map((spec) => spec.id));
    const pendingExpected = new Set(
      specs.filter((spec) => spec.status === 'draft' || spec.status === 'approved').map((spec) => spec.id),
    );
    const retiredExpected = new Set(specs.filter((spec) => spec.status === 'retired').map((spec) => spec.id));
    const shippedIds = idsOf(catalog.shipped, 'shipped');
    const pendingIds = idsOf(catalog.pending, 'pending');
    const retiredIds = idsOf(catalog.retired, 'retired');
    assert.deepEqual(sorted(shippedIds), sorted(implemented));
    assert.deepEqual(sorted(pendingIds), sorted(pendingExpected));
    assert.deepEqual(sorted(retiredIds), sorted(retiredExpected));
    for (const entry of catalog.shipped) {
      assert.equal(typeof entry?.title, 'string', `${entry?.id} title`);
      assert.ok(entry.title.trim().length > 0, `${entry?.id} title`);
      assert.equal(typeof entry?.requirement, 'string', `${entry?.id} requirement`);
      assert.ok(entry.requirement.trim().length > 0, `${entry?.id} requirement`);
    }
    assert.deepEqual(sorted(shippedIds).filter((id) => pendingIds.has(id)), []);
    const shippedBody = shippedMarkdown();
    for (const id of shippedIds) {
      assert.ok(mentionsAsLineOrH2(shippedBody, id), `shipped markdown missing ${id}`);
    }
    for (const id of [...pendingIds, ...retiredIds]) {
      assert.equal(mentionsAsLineOrH2(shippedBody, id), false, `shipped markdown includes ${id}`);
    }
  });

  test('未实现规格和方向与已交付功能分开 [AC:product-prd#AC-3]', () => {
    buildCatalog();
    const catalog = readCatalog();
    const specs = loadSpecs();
    const implemented = specs.filter((spec) => spec.status === 'implemented').map((spec) => spec.id);
    const pendingIds = idsOf(catalog.pending, 'pending');
    const fromAcceptance = readRepo('doc/prd/backlog/from-acceptance.md');
    for (const id of pendingIds) {
      assert.ok(containsIdToken(fromAcceptance, id), `from-acceptance missing ${id}`);
    }
    for (const id of implemented) {
      assert.equal(isH2(fromAcceptance, id), false, `from-acceptance has shipped heading ${id}`);
    }
    const direction = readRepo('doc/prd/backlog/direction.md');
    const promises = direction.match(/还不是承诺/g) ?? [];
    assert.ok(promises.length >= 5, `还不是承诺 × ${promises.length}`);
    for (const phrase of ['用户现在可以', '已经交付', '已经实现']) {
      assert.equal(direction.includes(phrase), false, `direction.md contains ${phrase}`);
    }
    const backlog = readRepo('doc/prd/backlog/README.md');
    assert.match(backlog, /方向/);
    assert.match(backlog, /还不是承诺/);
    assert.match(backlog, /from-acceptance\.md/);
  });

  test('技能要求同步产品需求目录且技能对照一致 [AC:product-prd#AC-4]', () => {
    const productPrd = readRepo('skills/product-prd/SKILL.md');
    assert.match(productPrd, /doc\/prd/);
    assert.match(productPrd, /node scripts\/prd\/build-catalog\.mjs/);
    assert.match(productPrd, /而不是只改 README/);
    assert.match(readRepo('skills/ppeng-agent-core-workspace/SKILL.md'), /product-prd/);
    assert.match(readRepo('skills/acceptance-first/SKILL.md'), /product-prd/);
    buildCatalog();
    const catalog = readCatalog();
    assert.ok(Array.isArray(catalog.skills), 'catalog.skills must be an array');
    const expected = diskSkills();
    const actual = catalog.skills.map(normalizeCatalogSkill);
    assert.deepEqual(
      actual.slice().sort((a, b) => a.path.localeCompare(b.path)),
      expected.slice().sort((a, b) => a.path.localeCompare(b.path)),
    );
    const skillsMd = readRepo('doc/prd/current/skills.md');
    for (const skill of expected) {
      assert.ok(skillsMd.includes(skill.name), `skills.md missing ${skill.name}`);
    }
  });
});
