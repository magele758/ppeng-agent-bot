import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const goalCss = readFileSync(new URL('./goal-history.css', import.meta.url), 'utf8');
const buttonCss = readFileSync(new URL('../legacy-vanilla/styles.css', import.meta.url), 'utf8');
const goalSource = readFileSync(new URL('./GoalHistory.tsx', import.meta.url), 'utf8');

function ruleBody(css: string, selector: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(selector, from);
    if (at < 0) break;
    const rest = source.slice(at + selector.length);
    if (/^\s*[,{]/.test(rest)) {
      const open = source.indexOf('{', at);
      let depth = 0;
      let end = open;
      for (; end < source.length; end += 1) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      return source.slice(open + 1, end);
    }
    from = at + selector.length;
  }
  assert.fail(`missing ${selector}`);
}

function decl(body: string, prop: string): string {
  const match = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'm'));
  assert.ok(match, `missing ${prop}`);
  return match[1].trim();
}

const nudged = /margin-top\s*:|margin-bottom\s*:|transform\s*:|translateY\s*\(|(?:^|;)\s*top\s*:|align-self\s*:\s*(?:flex-start|flex-end|start|end)\b/;

test('目标历史与相邻按钮同一套垂直居中 [AC:goal-history-toolbar-align#AC-1]', () => {
  const button = ruleBody(buttonCss, '.btn');
  const history = ruleBody(goalCss, '.goal-history');
  const summary = ruleBody(goalCss, '.goal-history > summary');
  assert.equal(decl(button, 'align-items'), 'center');
  assert.equal(decl(history, 'align-items'), 'center');
  assert.match(decl(history, 'display'), /flex/);
  assert.equal(decl(summary, 'align-items'), decl(button, 'align-items'));
  assert.match(decl(summary, 'display'), /inline-flex|flex/);
  assert.equal(decl(summary, 'line-height'), decl(button, 'min-height'));
  assert.equal(decl(summary, 'min-height'), decl(button, 'min-height'));
  assert.doesNotMatch(history, nudged);
  assert.doesNotMatch(summary, nudged);
  assert.match(goalSource, /<details className="goal-history"/);
  assert.match(goalSource, /<summary>\{t\('goals\.history'\)\}<\/summary>/);
});

test('展开三角和目标历史文字彼此垂直居中 [AC:goal-history-toolbar-align#AC-2]', () => {
  const summary = ruleBody(goalCss, '.goal-history > summary');
  const marker = ruleBody(goalCss, '.goal-history > summary::before');
  assert.match(decl(summary, 'display'), /inline-flex|flex/);
  assert.equal(decl(summary, 'align-items'), 'center');
  assert.equal(decl(marker, 'content'), '""');
  assert.doesNotMatch(marker, nudged);
  assert.doesNotMatch(ruleBody(goalCss, '.goal-history[open] > summary::before'), nudged);
});
