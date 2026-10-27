/**
 * Acceptance gate: executable acceptance criteria (`acceptance/<feature-id>.yaml`) traced to tests.
 *
 * Tests link to criteria with `[AC:<feature-id>#<criterion-id>]` in their title. The gate checks
 * statically that every criterion of an approved/implemented spec is referenced by a test, and,
 * when JUnit results are supplied, that at least one referencing test passed and none failed.
 *
 * Rules are unit-testable; the checked-in flaky exception list is shared with the retry runner.
 */
import { isKnownFlaky } from '../ci/known-flaky.mjs';
import { parseDocument } from 'yaml';

export const STATUSES = ['draft', 'approved', 'implemented', 'retired'];
export const GATED_STATUSES = new Set(['approved', 'implemented']);

const FEATURE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CRITERION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAG_RE = /\[AC:([^\]\r\n]*)\]/g;
const KNOWN_SPEC_KEYS = new Set(['id', 'title', 'status', 'requirement', 'criteria', 'retiredReason', 'owner', 'notes', 'links', 'verificationStage']);
const KNOWN_CRITERION_KEYS = new Set(['id', 'given', 'when', 'then', 'notes']);
const CRITERION_TEXT_FIELDS = ['given', 'when', 'then'];

/** `[AC:feature#AC-1]` for docs and messages. */
export function formatTag(featureId, criterionId) {
  return `[AC:${featureId}#${criterionId}]`;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateCriterion(c, index, where, errors, warnings, seen) {
  const label = `${where} criteria[${index}]`;
  if (!isPlainObject(c)) {
    errors.push(`${label}: must be a mapping with id/given/when/then`);
    return null;
  }
  if (typeof c.id !== 'string' || !CRITERION_ID_RE.test(c.id)) {
    errors.push(`${label}: id must match ${CRITERION_ID_RE} (got ${JSON.stringify(c.id)})`);
    return null;
  }
  if (seen.has(c.id)) {
    errors.push(`${where}: duplicate criterion id ${c.id}`);
    return null;
  }
  seen.add(c.id);
  for (const field of CRITERION_TEXT_FIELDS) {
    if (!isNonEmptyString(c[field])) errors.push(`${where} ${c.id}: \`${field}\` must be a non-empty string`);
  }
  for (const key of Object.keys(c)) {
    if (!KNOWN_CRITERION_KEYS.has(key)) warnings.push(`${where} ${c.id}: unknown field \`${key}\` (ignored)`);
  }
  return { id: c.id, given: String(c.given ?? ''), when: String(c.when ?? ''), then: String(c.then ?? '') };
}

/**
 * Validates an already-parsed spec object against the fixed schema.
 * `stem` is the filename without `.yaml`; the spec id must equal it.
 */
export function validateSpec(raw, stem, where = `acceptance/${stem}.yaml`) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) return { spec: null, errors: [`${where}: top level must be a mapping`], warnings };

  if (typeof raw.id !== 'string' || !FEATURE_ID_RE.test(raw.id)) {
    errors.push(`${where}: id must be kebab-case (got ${JSON.stringify(raw.id)})`);
  } else if (raw.id !== stem) {
    errors.push(`${where}: id "${raw.id}" must equal the filename stem "${stem}"`);
  }
  if (!isNonEmptyString(raw.title)) errors.push(`${where}: \`title\` must be a non-empty string`);
  if (!STATUSES.includes(raw.status)) {
    errors.push(`${where}: status must be one of ${STATUSES.join(' | ')} (got ${JSON.stringify(raw.status)})`);
  }
  if (!isNonEmptyString(raw.requirement)) errors.push(`${where}: \`requirement\` (the user's original words) must be a non-empty string`);
  if (raw.verificationStage !== undefined && !['software', 'deployment'].includes(raw.verificationStage)) errors.push(`${where}: invalid verificationStage`);
  if (raw.status === 'retired' && !isNonEmptyString(raw.retiredReason)) {
    warnings.push(`${where}: retired spec should explain why in \`retiredReason\``);
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SPEC_KEYS.has(key)) warnings.push(`${where}: unknown field \`${key}\` (ignored)`);
  }

  const criteria = [];
  if (!Array.isArray(raw.criteria) || raw.criteria.length === 0) {
    errors.push(`${where}: \`criteria\` must be a non-empty list`);
  } else {
    const seen = new Set();
    raw.criteria.forEach((c, i) => {
      const ok = validateCriterion(c, i, where, errors, warnings, seen);
      if (ok) criteria.push(ok);
    });
  }

  if (errors.length) return { spec: null, errors, warnings };
  return {
    spec: {
      id: raw.id,
      title: raw.title.trim(),
      status: raw.status,
      verificationStage: raw.verificationStage ?? 'software',
      requirement: raw.requirement.trim(),
      retiredReason: isNonEmptyString(raw.retiredReason) ? raw.retiredReason.trim() : undefined,
      file: where,
      criteria,
    },
    errors,
    warnings,
  };
}

/** Parses + validates one spec file. Duplicate YAML keys are errors. */
export function parseSpec(text, fileName) {
  const base = fileName.split('/').pop();
  const where = `acceptance/${base}`;
  if (!base.endsWith('.yaml')) {
    return { spec: null, errors: [`${where}: acceptance specs must use the .yaml extension`], warnings: [] };
  }
  const stem = base.slice(0, -'.yaml'.length);
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length) {
    return {
      spec: null,
      errors: doc.errors.map((e) => `${where}: YAML ${e.code ?? 'error'}: ${e.message.split('\n')[0]}`),
      warnings: [],
    };
  }
  return validateSpec(doc.toJS(), stem, where);
}

/**
 * Extracts acceptance tags from a test title. Malformed tags are returned with `error`
 * so the gate can reject them instead of silently ignoring a typo.
 */
export function extractTags(title) {
  const tags = [];
  for (const m of String(title).matchAll(TAG_RE)) {
    const body = m[1].trim();
    const hash = body.indexOf('#');
    const featureId = hash === -1 ? body : body.slice(0, hash);
    const criterionId = hash === -1 ? '' : body.slice(hash + 1);
    const tag = { raw: m[0], featureId, criterionId };
    if (!FEATURE_ID_RE.test(featureId) || !CRITERION_ID_RE.test(criterionId)) {
      tag.error = `malformed acceptance tag ${m[0]} (expected ${formatTag('<feature-id>', '<criterion-id>')})`;
    }
    tags.push(tag);
  }
  return tags;
}

/*
 * test( / it( / describe( / suite( with optional modifiers (test.describe, it.only, test.skip, ...),
 * not preceded by an identifier char or dot (so `re.test(` / `foo.it(` don't match), followed by a
 * string / template literal first argument.
 */
const TEST_CALL_RE = /(?<![\w$.])(test|it|describe|suite)((?:\.[A-Za-z_$][\w$]*)*)\s*\(\s*(['"`])((?:\\[\s\S]|(?!\3)[^\\])*?)\3/g;
/* `it.each(table)('title', fn)` / `describe.skip.each([...])(...)`: the title is the literal after the table call. */
const EACH_CALL_RE = /(?<![\w$.])(test|it|describe|suite)((?:\.[A-Za-z_$][\w$]*)*)\.each\s*\(/g;
const TITLE_LITERAL_RE = /^\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*?)\1/;
const INACTIVE_MODIFIERS = new Set(['skip', 'todo', 'fixme']);

/** Index just past the `)` closing the `(` at `open`, skipping string/template literals; -1 if unbalanced. */
function skipBalanced(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === '\\') i++;
    } else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function eachCalls(source) {
  const calls = [];
  for (const m of source.matchAll(EACH_CALL_RE)) {
    const end = skipBalanced(source, m.index + m[0].length - 1);
    if (end < 0) continue;
    const title = TITLE_LITERAL_RE.exec(source.slice(end));
    if (title) calls.push({ index: m.index, modifiers: m[2], title: title[2] });
  }
  return calls;
}

/**
 * Lists test titles carrying acceptance tags in one test source file. `active` is false for
 * `.skip` / `.todo` / `.fixme` calls: those don't count as coverage even statically.
 */
export function scanTestSource(source, file) {
  const calls = [
    ...[...source.matchAll(TEST_CALL_RE)].map((m) => ({ index: m.index, modifiers: m[2], title: m[4] })),
    ...eachCalls(source),
  ].sort((a, b) => a.index - b.index);
  const found = [];
  for (const { index, modifiers, title } of calls) {
    const tags = extractTags(title);
    if (!tags.length) continue;
    const mods = modifiers.split('.').filter(Boolean);
    found.push({
      file,
      line: source.slice(0, index).split('\n').length,
      title,
      tags,
      active: !mods.some((mod) => INACTIVE_MODIFIERS.has(mod)),
    });
  }
  return found;
}

/** Every `[AC:...]` occurrence in a file, title or not (used to spot tags outside runnable tests). */
export function containsTag(source) {
  TAG_RE.lastIndex = 0;
  return TAG_RE.test(source);
}

/** Minimal glob → RegExp for repo-relative POSIX paths: `**` spans dirs, `*` / `?` stay within one. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * File patterns from a `node ... --test <patterns>` npm script (the `test:unit` script is the
 * single source of truth for which files the node runner executes).
 */
export function nodeTestPatterns(script) {
  const tokens = String(script).trim().split(/\s+/);
  const at = tokens.indexOf('--test');
  if (at === -1) return [];
  const patterns = [];
  for (const tok of tokens.slice(at + 1)) {
    if (tok === '&&' || tok === '||' || tok === ';') break;
    if (tok.startsWith('-')) continue;
    patterns.push(tok.replace(/^['"]|['"]$/g, ''));
  }
  return patterns;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[ent] ?? whole;
  });
}

function parseAttrs(s) {
  const attrs = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = decodeXml(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/*
 * Tokenizer over the subset of XML JUnit reporters emit. Comments, CDATA, processing instructions
 * and text are skipped; only elements matter.
 */
const XML_TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

/**
 * Parses JUnit XML from node:test (`--test-reporter=junit`), vitest (`--reporter=junit`) and
 * Playwright (`--reporter=junit`) into flat test outcomes.
 *
 * `title` joins ancestor <testsuite> names with the testcase name, so tags on node:test
 * `describe` blocks (nested <testsuite>) apply to their tests. Outcome: failed if the case has
 * <failure>/<error> (even when also marked todo); skipped if it only has <skipped>; else passed.
 */
export function parseJUnit(xml) {
  const cases = [];
  const suites = [];
  let current = null;
  let sawRoot = false;
  for (const m of xml.matchAll(XML_TOKEN_RE)) {
    const [, closeName, openName, attrText, selfClose] = m;
    if (closeName) {
      if (closeName === 'testsuite') suites.pop();
      else if (closeName === 'testcase' && current) {
        cases.push(finishCase(current));
        current = null;
      }
      continue;
    }
    if (!openName) continue;
    if (openName === 'testsuites' || openName === 'testsuite') sawRoot = true;
    if (openName === 'testsuite') {
      if (!selfClose) suites.push(parseAttrs(attrText).name ?? '');
    } else if (openName === 'testcase') {
      const attrs = parseAttrs(attrText);
      const node = { name: attrs.name ?? '', classname: attrs.classname ?? '', suites: [...suites], failed: false, skipped: false };
      if (attrs.failure !== undefined) node.failed = true;
      if (selfClose) cases.push(finishCase(node));
      else current = node;
    } else if (current && (openName === 'failure' || openName === 'error')) {
      current.failed = true;
    } else if (current && openName === 'skipped') {
      current.skipped = true;
    }
  }
  if (current) cases.push(finishCase(current));
  if (!sawRoot) throw new Error('not a JUnit XML document (no <testsuites>/<testsuite>)');
  return cases;
}

function finishCase(node) {
  const title = [...node.suites.filter(Boolean), node.name].join(' > ');
  const outcome = node.failed ? 'failed' : node.skipped ? 'skipped' : 'passed';
  return { title, name: node.name, classname: node.classname, outcome };
}

/**
 * Collapses repeated executions of the same test (CI retries, the same suite run twice) into one
 * outcome: failed if any run failed, else passed if any passed, else skipped. `unit.retry-1.xml`
 * (written by scripts/ci/retry-failed-tests.mjs) counts as another run of `unit.xml`.
 */
export function dedupeResults(results) {
  const byKey = new Map();
  for (const r of results) {
    const source = (r.source ?? '').replace(/\.retry-\d+(?=\.xml$)/, '');
    const key = `${source}\u0000${r.classname ?? ''}\u0000${r.title}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  return [...byKey.values()].map(runs => {
    const failed = runs.some(r => r.outcome === 'failed');
    const passed = runs.some(r => r.outcome === 'passed');
    const retries = runs.filter(r => /\.retry-\d+\.xml$/.test(r.source ?? ''));
    const recovered = failed && retries.length > 0 && retries.every(r => r.outcome === 'passed');
    return {
      ...runs[0],
      outcome: failed ? 'failed' : passed ? 'passed' : 'skipped',
      ...(failed && passed ? { mixedResults: true } : {}),
      ...(recovered ? { retryRecovered: true } : {})
    };
  });
}

function criterionKey(featureId, criterionId) {
  return `${featureId}#${criterionId}`;
}

function checkTag(tag, location, specsById, errors, warnings) {
  if (tag.error) {
    errors.push(`${location}: ${tag.error}`);
    return null;
  }
  const spec = specsById.get(tag.featureId);
  if (!spec) {
    errors.push(`${location}: ${tag.raw} references unknown spec "${tag.featureId}" (no acceptance/${tag.featureId}.yaml)`);
    return null;
  }
  if (!spec.criteria.some((c) => c.id === tag.criterionId)) {
    errors.push(`${location}: ${tag.raw} references unknown criterion "${tag.criterionId}" of spec "${spec.id}"`);
    return null;
  }
  if (spec.status === 'retired') {
    warnings.push(`${location}: ${tag.raw} references retired spec "${spec.id}"; drop the tag or the test`);
  }
  return criterionKey(tag.featureId, tag.criterionId);
}

function omittedByPolicy(staticTests, omittedRunners) {
  if (!omittedRunners.includes('e2e')) return false;
  const active = staticTests.filter((t) => t.active);
  return active.length > 0 && active.every((t) => t.file === 'e2e' || t.file.startsWith('e2e/'));
}

function criterionState({ resultsMode, staticTests, resultTally }) {
  const activeStatic = staticTests.filter((t) => t.active).length;
  if (!resultsMode) return activeStatic > 0 ? 'covered' : 'missing';
  if (resultTally.failed > 0) return 'failing';
  if (resultTally.passed > 0) return 'passing';
  return activeStatic > 0 || resultTally.skipped > 0 ? 'not-run' : 'missing';
}

const FAILING_STATES = new Set(['missing', 'failing', 'not-run']);

function failureMessage(spec, c, state, tally) {
  const tag = formatTag(spec.id, c.id);
  const prefix = spec.status === 'approved' ? `${spec.file}: approved but not implemented — ` : `${spec.file}: `;
  if (state === 'missing') return `${prefix}${c.id} has no test tagged ${tag}`;
  if (state === 'failing') {
    return `${prefix}${c.id} has failing tagged test(s): ${tally.failedTitles.slice(0, 3).join(' | ')}`;
  }
  return `${prefix}${c.id}: no test tagged ${tag} passed in the supplied results (skipped/todo or not run)`;
}

/**
 * Core gate decision.
 *
 * @param {object} input
 * @param {Array} input.specs        validated specs
 * @param {string[]} [input.specErrors]   schema/parse errors (always fail)
 * @param {string[]} [input.specWarnings]
 * @param {Array} input.staticTests  output of scanTestSource across runnable test files
 * @param {string[]} [input.orphanFiles]  files with `[AC:` that no configured runner executes
 * @param {Array|null} [input.results]    parsed JUnit cases (null/undefined = static mode)
 * @param {string[]} [input.omittedRunners] runners intentionally not executed, e.g. cloud skips e2e
 */
export function evaluateAcceptance({ specs, specErrors = [], specWarnings = [], staticTests, orphanFiles = [], results = null, stage = 'all', omittedRunners = [] }) {
  if (!['all','software','deployment'].includes(stage)) throw new Error('Invalid acceptance stage');
  const errors = [...specErrors];
  const warnings = [...specWarnings];
  const notices = [];
  const resultsMode = Array.isArray(results);
  const specsById = new Map(specs.map((s) => [s.id, s]));

  for (const f of orphanFiles) {
    errors.push(`${f}: contains acceptance tags but is not executed by any configured test runner (test:unit / agent-loop vitest / Playwright)`);
  }

  const staticByCriterion = new Map();
  const rejectedTags = new Set();
  for (const t of staticTests) {
    for (const tag of t.tags) {
      const key = checkTag(tag, `${t.file}:${t.line}`, specsById, errors, warnings);
      if (!key) {
        rejectedTags.add(tag.raw);
        continue;
      }
      if (!staticByCriterion.has(key)) staticByCriterion.set(key, []);
      staticByCriterion.get(key).push({ file: t.file, line: t.line, title: t.title, active: t.active });
    }
  }

  const resultsByCriterion = new Map();
  const deduped = resultsMode ? dedupeResults(results) : [];
  if (resultsMode) {
    for (const r of deduped) {
      if (r.mixedResults) {
        const matches = staticTests.filter(t => t.title === r.name || t.title === r.title);
        const allowed = r.retryRecovered && matches.length === 1 && isKnownFlaky(matches[0].file, r.name);
        warnings.push('Failed then passed on retry' + (allowed ? ' (known flaky exception)' : ' (not a clean pass)') + ': ' + r.title);
        if (allowed) r.outcome = 'passed';
      }
      for (const tag of extractTags(r.title)) {
        // Rejected tags are reported once; results only add ones the static scan could not see (dynamic titles).
        const sink = rejectedTags.has(tag.raw) ? [] : errors;
        const key = checkTag(tag, `result "${r.title}"`, specsById, sink, []);
        if (!key) {
          rejectedTags.add(tag.raw);
          continue;
        }
        if (!resultsByCriterion.has(key)) resultsByCriterion.set(key, { passed: 0, failed: 0, skipped: 0, failedTitles: [], titles: [] });
        const tally = resultsByCriterion.get(key);
        tally[r.outcome] += 1;
        tally.titles.push({ title: r.title, outcome: r.outcome, source: r.source });
        if (r.outcome === 'failed') tally.failedTitles.push(r.title);
      }
    }
  }

  const specReports = [];
  for (const spec of [...specs].sort((a, b) => a.id.localeCompare(b.id))) {
    const criteria = spec.criteria.map((c) => {
      const key = criterionKey(spec.id, c.id);
      const staticList = staticByCriterion.get(key) ?? [];
      const tally = resultsByCriterion.get(key) ?? { passed: 0, failed: 0, skipped: 0, failedTitles: [], titles: [] };
      let state = criterionState({ resultsMode, staticTests: staticList, resultTally: tally });
      if (state === 'not-run' && omittedByPolicy(staticList, omittedRunners)) state = 'omitted';
      if (spec.status === 'draft') state = 'awaiting-approval';
      if (spec.status === 'retired') state = 'retired';
      return { ...c, state, tests: staticList, results: resultsMode ? tally : undefined };
    });

    const applicable = stage === 'all' || (spec.verificationStage ?? 'software') === stage;
    if (!applicable) notices.push(`${spec.file}: ${spec.verificationStage} acceptance remains ${spec.status}; not certified by the ${stage} gate`);
    if (GATED_STATUSES.has(spec.status) && applicable) {
      for (const c of criteria) {
        if (FAILING_STATES.has(c.state)) errors.push(failureMessage(spec, c, c.state, c.results ?? { failedTitles: [] }));
      }
      const allGood = criteria.every((c) => !FAILING_STATES.has(c.state));
      if (spec.status === 'approved' && allGood) {
        notices.push(`${spec.file}: every criterion is ${resultsMode ? 'passing' : 'covered'}; set \`status: implemented\` once the owner has seen it work`);
      }
    } else if (spec.status === 'draft') {
      notices.push(`${spec.file}: draft — ${criteria.length} criteria awaiting owner approval`);
    }

    const ok = !GATED_STATUSES.has(spec.status) || criteria.every((c) => !FAILING_STATES.has(c.state));
    specReports.push({ applicable, verificationStage: spec.verificationStage ?? 'software', id: spec.id, title: spec.title, status: spec.status, file: spec.file, retiredReason: spec.retiredReason, ok, criteria });
  }

  const resultSources = resultsMode
    ? Object.entries(
        deduped.reduce((acc, r) => {
          const s = r.source ?? '(unknown)';
          acc[s] ??= { passed: 0, failed: 0, skipped: 0 };
          acc[s][r.outcome] += 1;
          return acc;
        }, {}),
      ).map(([source, counts]) => ({ source, ...counts }))
    : [];

  return {
    ok: errors.length === 0,
    mode: resultsMode ? 'results' : 'static',
    stage,
    errors,
    warnings,
    notices,
    specs: specReports,
    resultSources,
    summary: summarize(specReports),
  };
}

function summarize(specReports) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let criteria = 0;
  let gatedCriteria = 0;
  let gatedOk = 0;
  for (const s of specReports) {
    byStatus[s.status] += 1;
    criteria += s.criteria.length;
    if (GATED_STATUSES.has(s.status) && s.applicable !== false) {
      gatedCriteria += s.criteria.length;
      gatedOk += s.criteria.filter((c) => !FAILING_STATES.has(c.state)).length;
    }
  }
  return { specs: specReports.length, byStatus, criteria, gatedCriteria, gatedOk };
}

const STATE_LABEL = {
  passing: '✅ passing',
  covered: '✅ tagged',
  failing: '❌ failing',
  'not-run': '❌ not run',
  omitted: '⏭ not run in this cloud gate',
  missing: '❌ no test',
  'awaiting-approval': '📝 awaiting owner approval',
  retired: '⏹ retired',
};

function mdCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/** Markdown summary for `$GITHUB_STEP_SUMMARY` / PR descriptions. */
export function renderMarkdown(report) {
  const { summary } = report;
  const lines = [];
  lines.push(`## Acceptance gate — ${report.ok ? '✅ pass' : '❌ fail'} (${report.mode} mode)`);
  lines.push('');
  lines.push(
    `${summary.specs} spec(s): ${STATUSES.map((s) => `${summary.byStatus[s]} ${s}`).join(', ')}. ` +
      `Gated criteria OK: ${summary.gatedOk}/${summary.gatedCriteria}.`,
  );
  if (report.stage) lines.push('', `Verification stage: **${report.stage}**. Other stages remain separately required.`);
  if (report.resultSources.length) {
    lines.push('');
    lines.push('Results ingested: ' + report.resultSources.map((r) => `\`${r.source}\` ${r.passed}✓ ${r.failed}✗ ${r.skipped}⊘`).join(', '));
  }
  if (report.errors.length) {
    lines.push('', '### Errors', '');
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  if (report.warnings.length) {
    lines.push('', '### Warnings', '');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  if (report.notices.length) {
    lines.push('', '### Notices', '');
    for (const n of report.notices) lines.push(`- ${n}`);
  }
  for (const spec of report.specs) {
    lines.push('', `### \`${spec.id}\` — ${mdCell(spec.title)} (${spec.status})`, '');
    if (spec.applicable === false) lines.push(`**${spec.verificationStage}: pending separate acceptance; this gate does not certify these criteria.**`, '');
    if (spec.retiredReason) lines.push(`Retired: ${mdCell(spec.retiredReason)}`, '');
    lines.push('| Criterion | Given | When | Then | State | Tests |', '|---|---|---|---|---|---|');
    for (const c of spec.criteria) {
      const tests = c.results ? `${c.results.passed}✓ ${c.results.failed}✗ ${c.results.skipped}⊘` : String(c.tests.filter((t) => t.active).length);
      lines.push(`| ${c.id} | ${mdCell(c.given)} | ${mdCell(c.when)} | ${mdCell(c.then)} | ${STATE_LABEL[c.state]} | ${tests} |`);
    }
  }
  if (!report.specs.length) lines.push('', '_No acceptance specs (acceptance/*.yaml)._');
  return lines.join('\n') + '\n';
}
