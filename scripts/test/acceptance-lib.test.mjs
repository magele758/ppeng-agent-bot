import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeXml,
  dedupeResults,
  evaluateAcceptance,
  extractTags,
  formatTag,
  globToRegExp,
  nodeTestPatterns,
  parseJUnit,
  parseSpec,
  renderMarkdown,
  scanTestSource,
  validateSpec,
} from '../acceptance/acceptance-lib.mjs';

// Tags in fixtures are built at runtime so the gate's own static scan never mistakes them for real ones.
const tag = (featureId, criterionId) => formatTag(featureId, criterionId);

const SPEC_YAML = `id: demo
title: 演示功能
status: approved
requirement: |
  用户原话
criteria:
  - id: AC-1
    given: 已登录
    when: 点击保存
    then: 看到「已保存」
  - id: AC-2
    given: 未登录
    when: 点击保存
    then: 跳到登录页
`;

function spec(overrides = {}) {
  const { spec: s, errors } = parseSpec(SPEC_YAML, 'demo.yaml');
  assert.deepEqual(errors, []);
  return { ...s, ...overrides };
}

function staticTest(featureId, criterionId, extra = {}) {
  return { file: 'scripts/test/x.test.mjs', line: 1, title: `t ${tag(featureId, criterionId)}`, tags: extractTags(tag(featureId, criterionId)), active: true, ...extra };
}

function result(title, outcome, source = 'unit.xml') {
  return { title, name: title, classname: '', outcome, source };
}

// ── spec parsing / schema ──────────────────────────────────────────────────

test('parseSpec reads the fixed schema, including multi-line requirement and Chinese text', () => {
  const { spec: s, errors, warnings } = parseSpec(SPEC_YAML, 'demo.yaml');
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(s.id, 'demo');
  assert.equal(s.status, 'approved');
  assert.equal(s.requirement, '用户原话');
  assert.equal(s.file, 'acceptance/demo.yaml');
  assert.deepEqual(s.criteria.map((c) => c.id), ['AC-1', 'AC-2']);
  assert.equal(s.criteria[0].then, '看到「已保存」');
});

test('schema errors fail: id/filename mismatch, bad status, empty criteria, missing fields [AC:acceptance-gate#AC-4]', () => {
  const mismatch = parseSpec(SPEC_YAML, 'other.yaml');
  assert.equal(mismatch.spec, null);
  assert.match(mismatch.errors.join('\n'), /must equal the filename stem "other"/);

  const badStatus = parseSpec(SPEC_YAML.replace('status: approved', 'status: done'), 'demo.yaml');
  assert.match(badStatus.errors.join('\n'), /status must be one of draft \| approved \| implemented \| retired/);

  const noCriteria = validateSpec({ id: 'demo', title: 't', status: 'draft', requirement: 'r', criteria: [] }, 'demo');
  assert.match(noCriteria.errors.join('\n'), /criteria` must be a non-empty list/);

  const missing = validateSpec(
    { id: 'demo', title: ' ', status: 'draft', criteria: [{ id: 'AC-1', given: 'g', when: '' }] },
    'demo',
  );
  const msg = missing.errors.join('\n');
  assert.match(msg, /title` must be a non-empty string/);
  assert.match(msg, /requirement`/);
  assert.match(msg, /AC-1: `when` must be a non-empty string/);
  assert.match(msg, /AC-1: `then` must be a non-empty string/);

  assert.match(validateSpec({ id: 'Bad_Id' }, 'Bad_Id').errors.join('\n'), /id must be kebab-case/);
  assert.match(validateSpec(['x'], 'x').errors[0], /top level must be a mapping/);
  assert.match(
    validateSpec({ id: 'demo', title: 't', status: 'draft', requirement: 'r', criteria: ['AC-1'] }, 'demo').errors.join('\n'),
    /criteria\[0\]: must be a mapping/,
  );
  assert.match(
    validateSpec({ id: 'demo', title: 't', status: 'draft', requirement: 'r', criteria: [{ id: 'AC 1', given: 'g', when: 'w', then: 't' }] }, 'demo').errors.join('\n'),
    /id must match/,
  );
});

test('duplicate criterion ids and duplicate YAML keys are errors [AC:acceptance-gate#AC-4]', () => {
  const dupCriterion = parseSpec(SPEC_YAML.replace('- id: AC-2', '- id: AC-1'), 'demo.yaml');
  assert.equal(dupCriterion.spec, null);
  assert.match(dupCriterion.errors.join('\n'), /duplicate criterion id AC-1/);

  const dupKey = parseSpec(SPEC_YAML.replace('status: approved', 'status: approved\nstatus: draft'), 'demo.yaml');
  assert.equal(dupKey.spec, null);
  assert.match(dupKey.errors.join('\n'), /YAML DUPLICATE_KEY/);

  const broken = parseSpec('id: demo\ncriteria: [unclosed', 'demo.yaml');
  assert.equal(broken.spec, null);
  assert.match(broken.errors[0], /^acceptance\/demo\.yaml: YAML /);
});

test('only .yaml is accepted; unknown fields warn; retired without reason warns', () => {
  assert.match(parseSpec(SPEC_YAML, 'demo.yml').errors[0], /must use the \.yaml extension/);

  const extra = parseSpec(SPEC_YAML.replace('title: 演示功能', 'title: 演示功能\npriority: high'), 'demo.yaml');
  assert.ok(extra.spec, 'optional fields must not break parsing');
  assert.match(extra.warnings.join('\n'), /unknown field `priority`/);

  const retired = parseSpec(SPEC_YAML.replace('status: approved', 'status: retired'), 'demo.yaml');
  assert.ok(retired.spec);
  assert.match(retired.warnings.join('\n'), /retiredReason/);
  const withReason = parseSpec(SPEC_YAML.replace('status: approved', 'status: retired\nretiredReason: 需求取消'), 'demo.yaml');
  assert.deepEqual(withReason.warnings, []);
  assert.equal(withReason.spec.retiredReason, '需求取消');
});

// ── tags & static scan ─────────────────────────────────────────────────────

test('extractTags finds every tag in a title and flags malformed ones', () => {
  const tags = extractTags(`saves ${tag('demo', 'AC-1')} and ${tag('other-feature', 'AC-12')}`);
  assert.deepEqual(tags.map((t) => [t.featureId, t.criterionId, t.error]), [
    ['demo', 'AC-1', undefined],
    ['other-feature', 'AC-12', undefined],
  ]);
  for (const bad of ['[AC:demo]', '[AC:Demo#AC-1]', '[AC:demo#]', '[AC:#AC-1]', '[AC:demo#AC 1]']) {
    assert.ok(extractTags(`x ${bad}`)[0].error, `${bad} should be malformed`);
  }
  assert.deepEqual(extractTags('no tags [AC] [ac:demo#AC-1]'), []);
});

test('scanTestSource reads titles of node:test, vitest and Playwright calls, ignoring non-test calls', () => {
  const t1 = tag('demo', 'AC-1');
  const t2 = tag('demo', 'AC-2');
  const src = [
    `test('saves ${t1}', () => {});`,
    `it("vitest style ${t2}", () => {});`,
    `test.describe(\`playwright block ${t1}\`, () => {});`,
    `describe('suite ${t2}', () => {});`,
    `if (/x/.test('not a test ${t1}')) {}`,
    `submit('nope ${t1}');`,
    `test('escaped \\' quote ${t2}', () => {});`,
    `test(name, () => {});`,
  ].join('\n');
  const found = scanTestSource(src, 'f.test.mjs');
  assert.deepEqual(found.map((f) => [f.line, f.tags.map((x) => x.criterionId).join(',')]), [
    [1, 'AC-1'],
    [2, 'AC-2'],
    [3, 'AC-1'],
    [4, 'AC-2'],
    [7, 'AC-2'],
  ]);
  assert.ok(found.every((f) => f.active && f.file === 'f.test.mjs'));
});

test('scanTestSource reads the title of table-driven .each(...)(title) tests', () => {
  const t1 = tag('demo', 'AC-1');
  const t2 = tag('demo', 'AC-2');
  const src = [
    `it.each(['a', 'b(', [1, {x: ')'}]])('%s: case ${t1}', async (name) => {});`,
    `describe.skip.each([`,
    `  ['x', 1],`,
    `])("%s grouped ${t2}", () => {});`,
    `it.each(rows)(titleFromVar, () => {});`,
  ].join('\n');
  const found = scanTestSource(src, 'f.test.ts');
  assert.deepEqual(found.map((f) => [f.line, f.tags[0].criterionId, f.active]), [
    [1, 'AC-1', true],
    [2, 'AC-2', false],
  ]);
});

test('cloud results do not fail criteria that only have browser tests [AC:ci-fast-and-bihourly-gates#AC-3] [AC:ci-action-reliability#AC-5]', () => {
  const s = spec({ status: 'implemented' });
  const e2eOnly = scanTestSource(`test('browser ${tag('demo', 'AC-1')}', () => {});`, 'e2e/demo.spec.ts');
  const unit = scanTestSource(`test('unit ${tag('demo', 'AC-2')}', () => {});`, 'packages/core/test/demo.test.js');
  const report = evaluateAcceptance({
    specs: [s],
    staticTests: [...e2eOnly, ...unit],
    results: [result(`unit ${tag('demo', 'AC-2')}`, 'passed', 'unit.xml')],
    omittedRunners: ['e2e'],
  });
  assert.equal(report.ok, true);
  assert.equal(report.specs[0].criteria.find((c) => c.id === 'AC-1').state, 'omitted');
  assert.equal(report.specs[0].criteria.find((c) => c.id === 'AC-2').state, 'passing');
  const required = evaluateAcceptance({
    specs: [s],
    staticTests: [...e2eOnly, ...unit],
    results: [result(`unit ${tag('demo', 'AC-2')}`, 'passed', 'unit.xml')],
  });
  assert.equal(required.ok, false);
});

test('skip / todo / fixme tests do not count as coverage statically [AC:acceptance-gate#AC-2]', () => {
  const t1 = tag('demo', 'AC-1');
  const src = `test.skip('a ${t1}', () => {});\nit.todo('b ${t1}');\ntest.fixme('c ${t1}', () => {});\ntest.only('d ${t1}', () => {});`;
  assert.deepEqual(scanTestSource(src, 'f').map((f) => f.active), [false, false, false, true]);

  const s = spec();
  const inactive = scanTestSource(`test.skip('a ${t1}', () => {});\ntest('b ${tag('demo', 'AC-2')}', () => {});`, 'f');
  const report = evaluateAcceptance({ specs: [s], staticTests: inactive });
  assert.equal(report.ok, false);
  assert.equal(report.specs[0].criteria[0].state, 'missing');
});

test('globToRegExp and nodeTestPatterns mirror how test:unit selects files', () => {
  assert.ok(globToRegExp('scripts/test/*.test.mjs').test('scripts/test/a.test.mjs'));
  assert.ok(!globToRegExp('scripts/test/*.test.mjs').test('scripts/test/sub/a.test.mjs'));
  assert.ok(globToRegExp('e2e/**/*.spec.ts').test('e2e/a.spec.ts'));
  assert.ok(globToRegExp('e2e/**/*.spec.ts').test('e2e/x/y/a.spec.ts'));
  assert.ok(!globToRegExp('a.b').test('axb'), 'dots are literal');
  assert.ok(globToRegExp('src/**').test('src/a/b.ts'));

  assert.deepEqual(
    nodeTestPatterns('node --experimental-strip-types --test packages/core/test/*.test.js "apps/x.test.ts" && echo done'),
    ['packages/core/test/*.test.js', 'apps/x.test.ts'],
  );
  assert.deepEqual(nodeTestPatterns('vitest run'), []);
});

// ── JUnit ingestion (fixtures trimmed from real runner output) ─────────────

const NODE_JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testsuite name="suite ${tag('demo', 'AC-1')}" time="0.0009" disabled="0" errors="0" tests="1" failures="0" skipped="0" hostname="h">
		<testcase name="inner &amp; &lt;ok>" time="0.0003" classname="test"/>
	</testsuite>
	<testcase name="pass ${tag('demo', 'AC-2')}" time="0.00007" classname="test"/>
	<testcase name="fail" time="0.0001" classname="test" failure="boom &lt;x>">
		<failure type="testCodeFailure" message="boom &lt;x>">
[Error [ERR_TEST_FAILURE]: boom &lt;x>] { code: 'ERR_TEST_FAILURE' }
		</failure>
	</testcase>
	<testcase name="skip" time="0.00006" classname="test">
		<skipped type="skipped" message="true"/>
	</testcase>
	<testcase name="todo" time="0.0001" classname="test">
		<skipped type="todo" message="true"/>
	</testcase>
	<testcase name="todo-fail" time="0.00007" classname="test" failure="x">
		<skipped type="todo" message="true"/>
		<failure type="testCodeFailure" message="x">x</failure>
	</testcase>
	<!-- tests 6 -->
	<!-- pass 2 -->
</testsuites>`;

const VITEST_JUNIT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="1" errors="0" time="0.286">
    <testsuite name="src/ptc/ptc-core.test.ts" timestamp="2026-10-08T12:20:45.697Z" hostname="h" tests="3" failures="1" errors="0" skipped="1" time="0.036">
        <testcase classname="src/ptc/ptc-core.test.ts" name="isolate &gt; runs ${tag('demo', 'AC-1')}" time="0.002">
        </testcase>
        <testcase classname="src/ptc/ptc-core.test.ts" name="isolate &gt; breaks ${tag('demo', 'AC-2')}" time="0.001">
            <failure message="expected 1 to be 2" type="AssertionError">
AssertionError: expected 1 to be 2 &lt;testcase&gt;
            </failure>
        </testcase>
        <testcase classname="src/ptc/ptc-core.test.ts" name="isolate &gt; later" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>`;

const PLAYWRIGHT_JUNIT = `<testsuites id="" name="" tests="3" failures="1" skipped="1" errors="0" time="0.47">
<testsuite name="x.spec.ts" timestamp="2026-10-08T12:25:38.218Z" hostname="chromium" tests="3" failures="1" skipped="1" time="0.009" errors="0">
<testcase name="Lab 冒烟 ${tag('demo', 'AC-1')} › passes &amp; &lt;ok&gt;" classname="x.spec.ts" time="0.003">
</testcase>
<testcase name="fails ${tag('demo', 'AC-2')}" classname="x.spec.ts" time="0.006">
<system-out>
<![CDATA[
[[ATTACHMENT|out/x-fails/error-context.md]]
]]>
</system-out>
<failure message="expect(received).toBe(expected)" type="expect.toBe">
<![CDATA[  [chromium] › x.spec.ts:5:1 › fails <testcase name="fake"/> ─────
    Error: expect(received).toBe(expected)
]]>
</failure>
</testcase>
<testcase name="skipped ${tag('demo', 'AC-2')}" classname="x.spec.ts">
<properties>
<property name="skip" value="">
</property>
</properties>
<skipped>
</skipped>
</testcase>
</testsuite>
</testsuites>`;

test('parseJUnit: node:test reporter — nested describe suites, failures, skip, todo [AC:acceptance-gate#AC-5]', () => {
  const cases = parseJUnit(NODE_JUNIT);
  assert.deepEqual(cases.map((c) => [c.title, c.outcome]), [
    [`suite ${tag('demo', 'AC-1')} > inner & <ok>`, 'passed'],
    [`pass ${tag('demo', 'AC-2')}`, 'passed'],
    ['fail', 'failed'],
    ['skip', 'skipped'],
    ['todo', 'skipped'],
    ['todo-fail', 'failed'],
  ]);
});

test('parseJUnit: vitest reporter [AC:acceptance-gate#AC-5]', () => {
  const cases = parseJUnit(VITEST_JUNIT);
  assert.deepEqual(cases.map((c) => c.outcome), ['passed', 'failed', 'skipped']);
  assert.equal(cases[0].title, `src/ptc/ptc-core.test.ts > isolate > runs ${tag('demo', 'AC-1')}`);
  assert.equal(cases[0].classname, 'src/ptc/ptc-core.test.ts');
});

test('parseJUnit: Playwright reporter, CDATA bodies are ignored [AC:acceptance-gate#AC-5]', () => {
  const cases = parseJUnit(PLAYWRIGHT_JUNIT);
  assert.deepEqual(cases.map((c) => c.outcome), ['passed', 'failed', 'skipped']);
  assert.equal(cases.length, 3, 'a <testcase> inside CDATA is not a test');
  assert.equal(cases[0].title, `x.spec.ts > Lab 冒烟 ${tag('demo', 'AC-1')} › passes & <ok>`);
});

test('parseJUnit rejects non-JUnit input; decodeXml handles numeric entities', () => {
  assert.throws(() => parseJUnit('{"tests": []}'), /not a JUnit XML document/);
  assert.deepEqual(parseJUnit('<testsuites></testsuites>'), []);
  assert.equal(decodeXml('&#60;&#x3E;&amp;&quot;&apos;&unknown;'), `<>&"'&unknown;`);
});

test('all three runners feed one evaluation: each criterion sees its own runner results [AC:acceptance-gate#AC-5]', () => {
  const s = spec();
  const results = [
    ...parseJUnit(NODE_JUNIT).map((c) => ({ ...c, source: 'unit.xml' })),
    ...parseJUnit(VITEST_JUNIT).map((c) => ({ ...c, source: 'vitest.xml' })),
    ...parseJUnit(PLAYWRIGHT_JUNIT).map((c) => ({ ...c, source: 'e2e.xml' })),
  ];
  const report = evaluateAcceptance({ specs: [s], staticTests: [staticTest('demo', 'AC-1'), staticTest('demo', 'AC-2')], results });
  const [ac1, ac2] = report.specs[0].criteria;
  assert.deepEqual([ac1.state, ac1.results.passed, ac1.results.failed], ['passing', 3, 0]);
  assert.deepEqual([ac2.state, ac2.results.passed, ac2.results.failed, ac2.results.skipped], ['failing', 1, 2, 1]);
  assert.deepEqual(report.resultSources.map((r) => r.source).sort(), ['e2e.xml', 'unit.xml', 'vitest.xml']);
  assert.equal(report.ok, false);
});

// ── gate semantics ─────────────────────────────────────────────────────────

test('static: approved spec with an untagged criterion fails as "approved but not implemented" [AC:acceptance-gate#AC-1]', () => {
  const report = evaluateAcceptance({ specs: [spec()], staticTests: [staticTest('demo', 'AC-1')] });
  assert.equal(report.ok, false);
  assert.equal(report.mode, 'static');
  assert.deepEqual(report.specs[0].criteria.map((c) => c.state), ['covered', 'missing']);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /acceptance\/demo\.yaml: approved but not implemented — AC-2 has no test tagged \[AC:demo#AC-2\]/);
});

test('static: implemented spec with an untagged criterion fails without the approved wording [AC:acceptance-gate#AC-1]', () => {
  const report = evaluateAcceptance({ specs: [spec({ status: 'implemented' })], staticTests: [] });
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 2);
  assert.ok(report.errors.every((e) => !e.includes('approved but not implemented')));
  assert.match(report.errors[0], /AC-1 has no test tagged/);
});

test('static: fully tagged specs pass; approved gets a nudge to mark implemented [AC:acceptance-gate#AC-1]', () => {
  const tests = [staticTest('demo', 'AC-1'), staticTest('demo', 'AC-2')];
  const approved = evaluateAcceptance({ specs: [spec()], staticTests: tests });
  assert.equal(approved.ok, true);
  assert.match(approved.notices.join('\n'), /set `status: implemented`/);
  const implemented = evaluateAcceptance({ specs: [spec({ status: 'implemented' })], staticTests: tests });
  assert.equal(implemented.ok, true);
  assert.deepEqual(implemented.notices, []);
});

test('draft specs never fail and are listed as awaiting owner approval [AC:acceptance-gate#AC-3]', () => {
  const report = evaluateAcceptance({ specs: [spec({ status: 'draft' })], staticTests: [], results: [] });
  assert.equal(report.ok, true);
  assert.deepEqual(report.specs[0].criteria.map((c) => c.state), ['awaiting-approval', 'awaiting-approval']);
  assert.match(report.notices[0], /draft — 2 criteria awaiting owner approval/);
  assert.match(renderMarkdown(report), /awaiting owner approval/);
});

test('results: a criterion needs a passing tagged test and no failing one [AC:acceptance-gate#AC-2]', () => {
  const s = spec();
  const tests = [staticTest('demo', 'AC-1'), staticTest('demo', 'AC-2')];
  const t1 = tag('demo', 'AC-1');
  const t2 = tag('demo', 'AC-2');

  const pass = evaluateAcceptance({ specs: [s], staticTests: tests, results: [result(`a ${t1}`, 'passed'), result(`b ${t2}`, 'passed')] });
  assert.equal(pass.ok, true);
  assert.equal(pass.mode, 'results');
  assert.deepEqual(pass.specs[0].criteria.map((c) => c.state), ['passing', 'passing']);

  const failing = evaluateAcceptance({
    specs: [s],
    staticTests: tests,
    results: [result(`a ${t1}`, 'passed'), result(`a2 ${t1}`, 'failed'), result(`b ${t2}`, 'passed')],
  });
  assert.equal(failing.ok, false);
  assert.match(failing.errors[0], /AC-1 has failing tagged test\(s\): a2/);
});

test('results: skipped/todo or never-run tagged tests do not count [AC:acceptance-gate#AC-2]', () => {
  const s = spec({ status: 'implemented' });
  const tests = [staticTest('demo', 'AC-1'), staticTest('demo', 'AC-2')];
  const report = evaluateAcceptance({ specs: [s], staticTests: tests, results: [result(`a ${tag('demo', 'AC-1')}`, 'skipped')] });
  assert.equal(report.ok, false);
  assert.deepEqual(report.specs[0].criteria.map((c) => c.state), ['not-run', 'not-run']);
  assert.match(report.errors.join('\n'), /AC-1: no test tagged \[AC:demo#AC-1\] passed in the supplied results/);
  assert.match(report.errors.join('\n'), /AC-2: no test tagged/);

  const noTestAtAll = evaluateAcceptance({ specs: [s], staticTests: [], results: [result('unrelated', 'passed')] });
  assert.deepEqual(noTestAtAll.specs[0].criteria.map((c) => c.state), ['missing', 'missing']);
});

test('results: a retried test that eventually passed counts as passed [AC:acceptance-gate#AC-2]', () => {
  const title = `flaky ${tag('demo', 'AC-1')}`;
  assert.deepEqual(dedupeResults([result(title, 'failed'), result(title, 'passed')]).map((r) => r.outcome), ['failed']);
  assert.deepEqual(dedupeResults([result(title, 'skipped'), result(title, 'failed')]).map((r) => r.outcome), ['failed']);
  assert.deepEqual(dedupeResults([result(title, 'failed'), result(title, 'skipped')]).map((r) => r.outcome), ['failed']);
  assert.equal(dedupeResults([result(title, 'passed', 'a.xml'), result(title, 'failed', 'b.xml')]).length, 2, 'different runs stay separate');
});

test('unknown spec / unknown criterion / malformed tags fail; retired spec tags warn [AC:acceptance-gate#AC-4]', () => {
  const s = spec({ status: 'draft' });
  const retired = { ...spec({ status: 'retired' }), id: 'old', file: 'acceptance/old.yaml' };
  const staticTests = [
    staticTest('nope', 'AC-1'),
    staticTest('demo', 'AC-9'),
    { file: 'f', line: 3, title: 'x [AC:demo]', tags: extractTags('x [AC:demo]'), active: true },
    staticTest('old', 'AC-1'),
  ];
  const report = evaluateAcceptance({ specs: [s, retired], staticTests });
  assert.equal(report.ok, false);
  const errs = report.errors.join('\n');
  assert.match(errs, /references unknown spec "nope" \(no acceptance\/nope\.yaml\)/);
  assert.match(errs, /references unknown criterion "AC-9" of spec "demo"/);
  assert.match(errs, /f:3: malformed acceptance tag \[AC:demo\]/);
  assert.equal(report.errors.length, 3);
  assert.match(report.warnings.join('\n'), /references retired spec "old"/);
  assert.equal(report.specs.find((x) => x.id === 'old').criteria[0].state, 'retired');
});

test('results: unknown tags only visible at runtime (dynamic titles) fail too, without double-reporting [AC:acceptance-gate#AC-4]', () => {
  const s = spec({ status: 'draft' });
  const bad = tag('ghost', 'AC-1');
  const report = evaluateAcceptance({
    specs: [s],
    staticTests: [staticTest('ghost', 'AC-1')],
    results: [result(`a ${bad}`, 'passed'), result(`b ${bad}`, 'passed'), result(`c ${tag('demo', 'AC-7')}`, 'passed')],
  });
  assert.equal(report.errors.filter((e) => e.includes('"ghost"')).length, 1);
  assert.match(report.errors.join('\n'), /result "c \[AC:demo#AC-7\]": .*unknown criterion "AC-7"/);
});

test('spec errors and orphan tag files fail the gate [AC:acceptance-gate#AC-4] [AC:acceptance-gate#AC-6]', () => {
  const report = evaluateAcceptance({
    specs: [],
    specErrors: ['acceptance/x.yaml: bad'],
    staticTests: [],
    orphanFiles: ['scripts/test/forgotten.test.mjs'],
  });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0], 'acceptance/x.yaml: bad');
  assert.match(report.errors[1], /forgotten\.test\.mjs: contains acceptance tags but is not executed by any configured test runner/);
});

test('renderMarkdown summarises status, ingested results and per-criterion state [AC:acceptance-gate#AC-7]', () => {
  const report = evaluateAcceptance({
    specs: [spec()],
    staticTests: [staticTest('demo', 'AC-1'), staticTest('demo', 'AC-2')],
    results: [result(`a ${tag('demo', 'AC-1')}`, 'passed', 'unit.xml'), result(`b ${tag('demo', 'AC-2')}`, 'failed', 'e2e.xml')],
  });
  const md = renderMarkdown(report);
  assert.match(md, /^## Acceptance gate — ❌ fail \(results mode\)/);
  assert.match(md, /1 spec\(s\): 0 draft, 1 approved, 0 implemented, 0 retired\. Gated criteria OK: 1\/2\./);
  assert.match(md, /`unit\.xml` 1✓ 0✗ 0⊘/);
  assert.match(md, /### `demo` — 演示功能 \(approved\)/);
  assert.match(md, /\| AC-1 \| 已登录 \| 点击保存 \| 看到「已保存」 \| ✅ passing \| 1✓ 0✗ 0⊘ \|/);
  assert.match(md, /\| AC-2 \| .* \| ❌ failing \|/);
  assert.match(md, /### Errors/);
  assert.match(renderMarkdown(evaluateAcceptance({ specs: [], staticTests: [] })), /No acceptance specs/);
  assert.deepEqual(report.summary, { specs: 1, byStatus: { draft: 0, approved: 1, implemented: 0, retired: 0 }, criteria: 2, gatedCriteria: 2, gatedOk: 1 });
});
