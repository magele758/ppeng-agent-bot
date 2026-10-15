/**
 * CRAP (Change Risk Anti-Patterns) metric, per function:
 *
 *   CRAP(m) = comp(m)^2 * (1 - cov(m))^3 + comp(m)
 *
 * comp = cyclomatic complexity, cov = statement coverage in [0, 1].
 * Everything here is pure so the gate logic is unit-testable without running suites.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

export const DEFAULT_THRESHOLD = 30;

export function crapScore(complexity, coverage) {
  const uncovered = 1 - Math.min(1, Math.max(0, coverage));
  return complexity * complexity * uncovered ** 3 + complexity;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_INDEX = new Map([...BASE64].map((c, i) => [c, i]));

/** Decodes source-map v3 `mappings` into [genLine][] of { genCol, source, line } (0-based). */
export function decodeMappings(mappings) {
  const lines = [];
  let source = 0;
  let origLine = 0;
  let origCol = 0;
  for (const lineText of mappings.split(';')) {
    const segments = [];
    let genCol = 0;
    if (lineText) {
      for (const segText of lineText.split(',')) {
        const fields = [];
        let value = 0;
        let shift = 0;
        for (const ch of segText) {
          const digit = BASE64_INDEX.get(ch);
          if (digit === undefined) throw new Error(`invalid base64 VLQ char: ${ch}`);
          value += (digit & 31) << shift;
          if (digit & 32) {
            shift += 5;
          } else {
            fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
            value = 0;
            shift = 0;
          }
        }
        genCol += fields[0];
        if (fields.length >= 4) {
          source += fields[1];
          origLine += fields[2];
          origCol += fields[3];
          segments.push({ genCol, source, line: origLine });
        }
      }
    }
    lines.push(segments);
  }
  return lines;
}

/**
 * Paints V8 block coverage onto a per-character array (1 = executed). Ranges are applied
 * outermost-first so nested (more specific) counts win, matching V8 semantics.
 */
export function paintV8Functions(functions, length) {
  const ranges = functions.flatMap((fn) => fn.ranges);
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const paint = new Uint8Array(length);
  for (const r of ranges) {
    paint.fill(r.count > 0 ? 1 : 0, Math.min(r.startOffset, length), Math.min(r.endOffset, length));
  }
  return paint;
}

/** Maps executed generated characters back to executed original lines (0-based) per source index. */
export function coveredSourceLines(generatedText, paint, decodedMappings) {
  const lineStarts = [0];
  for (let i = 0; i < generatedText.length; i++) {
    if (generatedText.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const bySource = new Map();
  decodedMappings.forEach((segments, genLine) => {
    const start = lineStarts[genLine];
    if (start === undefined) return;
    for (const seg of segments) {
      if (!paint[start + seg.genCol]) continue;
      let set = bySource.get(seg.source);
      if (!set) bySource.set(seg.source, (set = new Set()));
      set.add(seg.line);
    }
  });
  return bySource;
}

/** Executed lines (0-based) from an istanbul FileCoverage JSON (e.g. vitest coverage-final.json). */
export function coveredLinesFromIstanbul(fileCoverage) {
  const lines = new Set();
  for (const [id, loc] of Object.entries(fileCoverage.statementMap ?? {})) {
    if ((fileCoverage.s?.[id] ?? 0) > 0) {
      for (let l = loc.start.line; l <= loc.end.line; l++) lines.add(l - 1);
    }
  }
  return lines;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

const DECISION_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
]);

const SHORT_CIRCUIT_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** McCabe cyclomatic complexity; nested functions are scored separately. */
export function cyclomaticComplexity(fnNode) {
  let complexity = 1;
  const visit = (node) => {
    if (node !== fnNode && isFunctionLike(node)) return;
    if (DECISION_KINDS.has(node.kind)) complexity++;
    else if (ts.isBinaryExpression(node) && SHORT_CIRCUIT_OPERATORS.has(node.operatorToken.kind)) complexity++;
    ts.forEachChild(node, visit);
  };
  visit(fnNode);
  return complexity;
}

const NON_EXECUTABLE_STATEMENTS = new Set([
  ts.SyntaxKind.Block,
  ts.SyntaxKind.EmptyStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
]);

function isExecutableStatement(node) {
  if (!ts.isStatement(node) || NON_EXECUTABLE_STATEMENTS.has(node.kind)) return false;
  if (ts.isEnumDeclaration(node)) return false;
  if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return false;
  return true;
}

/** Start lines (0-based) of statements owned by fnNode, excluding nested functions. */
function statementLines(fnNode, sourceFile) {
  const lines = [];
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  if (!fnNode.body) return lines;
  if (!ts.isBlock(fnNode.body)) {
    lines.push(lineOf(fnNode.body));
    return lines;
  }
  const visit = (node) => {
    if (isFunctionLike(node) || ts.isClassLike(node)) return;
    if (isExecutableStatement(node)) lines.push(lineOf(node));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fnNode.body, visit);
  return lines;
}

function propertyNameText(name, sourceFile) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return name.getText(sourceFile);
}

function stringProperty(objectLiteral, key) {
  for (const prop of objectLiteral.properties) {
    if (ts.isPropertyAssignment(prop) && propertyNameText(prop.name, prop.getSourceFile()) === key) {
      if (ts.isStringLiteralLike(prop.initializer)) return prop.initializer.text;
    }
  }
  return undefined;
}

function compactText(text, max = 48) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A stable, line-number-free name, so the baseline survives unrelated edits.
 * Route handlers `{ method, pattern, handler }` are named by their route.
 */
function ownName(node, sourceFile) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isGetAccessorDeclaration(node)) return `get ${propertyNameText(node.name, sourceFile)}`;
  if (ts.isSetAccessorDeclaration(node)) return `set ${propertyNameText(node.name, sourceFile)}`;
  if (node.name) return propertyNameText(node.name, sourceFile);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    const prop = propertyNameText(parent.name, sourceFile);
    if (ts.isObjectLiteralExpression(parent.parent)) {
      const method = stringProperty(parent.parent, 'method');
      const pattern = stringProperty(parent.parent, 'pattern') ?? stringProperty(parent.parent, 'path');
      if (method && pattern) return `${method} ${pattern}`;
    }
    return prop;
  }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    return `<cb:${compactText(parent.expression.getText(sourceFile))}>`;
  }
  if (ts.isExportAssignment(parent)) return 'default';
  return '<anon>';
}

function containerName(node, sourceFile) {
  if (ts.isClassLike(node)) return node.name ? node.name.text : '<class>';
  if (isFunctionLike(node)) return ownName(node, sourceFile);
  return undefined;
}

function qualifiedName(node, sourceFile) {
  const parts = [ownName(node, sourceFile)];
  for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
    const name = containerName(p, sourceFile);
    if (name) parts.unshift(name);
  }
  return parts.join('.');
}

/**
 * Lists every function with a body in a TS/JS source text.
 * @returns {{ name: string, line: number, complexity: number, statementLines: number[] }[]}
 */
export function collectFunctions(fileName, text) {
  const kind = /\.[cm]?tsx?$/.test(fileName) ? (fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const seen = new Map();
  const visit = (node) => {
    if (isFunctionLike(node) && node.body) {
      const base = qualifiedName(node, sourceFile);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      out.push({
        name: n === 1 ? base : `${base}#${n}`,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        complexity: cyclomaticComplexity(node),
        statementLines: statementLines(node, sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/**
 * Scores the functions of one file against a set of executed lines (0-based).
 * A function without executable statements counts as fully covered.
 */
export function scoreFunctions(file, functions, coveredLines) {
  return functions.map((fn) => {
    const total = fn.statementLines.length;
    const hit = coveredLines ? fn.statementLines.filter((l) => coveredLines.has(l)).length : 0;
    const coverage = total === 0 ? 1 : hit / total;
    return {
      key: `${file}::${fn.name}`,
      file,
      name: fn.name,
      line: fn.line,
      complexity: fn.complexity,
      coverage: Math.round(coverage * 1000) / 1000,
      crap: Math.round(crapScore(fn.complexity, coverage) * 10) / 10,
    };
  });
}

/** Small absolute slack absorbs coverage noise from timing-dependent paths. */
export function allowedCrap(baselineCrap, coverage) {
  if (coverage === 0) return baselineCrap;
  return baselineCrap * 1.05 + 1;
}

/**
 * Ratchet gate: existing debt (the baseline) may stay or shrink, never grow, and no
 * function outside the baseline may exceed the threshold.
 */
export function evaluateGate(rows, baseline, threshold = DEFAULT_THRESHOLD) {
  const baselineEntries = baseline?.functions ?? {};
  const regressions = [];
  const newViolations = [];
  const improved = [];
  const current = new Map(rows.map((r) => [r.key, r]));
  for (const row of rows) {
    if (row.crap <= threshold) continue;
    const prior = baselineEntries[row.key];
    if (!prior) newViolations.push(row);
    else if (row.crap > allowedCrap(prior.crap, prior.coverage)) regressions.push({ ...row, baselineCrap: prior.crap, baselineCoverage: prior.coverage });
  }
  for (const [key, prior] of Object.entries(baselineEntries)) {
    const row = current.get(key);
    if (!row || row.crap <= threshold || row.crap < prior.crap - 0.5) {
      improved.push({ key, baselineCrap: prior.crap, crap: row?.crap ?? null });
    }
  }
  const byCrap = (a, b) => b.crap - a.crap;
  return {
    pass: regressions.length === 0 && newViolations.length === 0,
    threshold,
    newViolations: newViolations.sort(byCrap),
    regressions: regressions.sort(byCrap),
    improved,
    debtCount: rows.filter((r) => r.crap > threshold).length,
  };
}

export function buildBaseline(rows, threshold = DEFAULT_THRESHOLD) {
  const functions = {};
  for (const row of [...rows].sort((a, b) => a.key.localeCompare(b.key))) {
    if (row.crap > threshold) {
      functions[row.key] = { crap: row.crap, complexity: row.complexity, coverage: row.coverage };
    }
  }
  return { version: 1, threshold, functions };
}
