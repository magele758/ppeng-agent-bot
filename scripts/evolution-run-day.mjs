#!/usr/bin/env node
/**
 * 读取 doc/evolution/inbox 最新 md，对每条候选创建 git worktree、npm ci、跑测试；
 * 写 doc/evolution/success 或 failure；可选合并到主分支（默认关闭）。
 *
 * 环境变量见 .env.example EVOLUTION_*
 *
 * 说明：脚本启动时会 loadDotenv(主仓 .env)，子进程已继承这些变量；仍会可选地把主仓 .env、
 * gateway 配置文件复制进每个 worktree，便于在目录内跑 evolution:learn / daemon 等与读 cwd 下
 * 文件的流程一致。跑测试命令时会从子进程环境剥离 `RAW_AGENT_SELF_HEAL_*`（与默认单测一致），除非
 * `EVOLUTION_PRESERVE_SELF_HEAL_ENV=1`。
 *
 * 可选 `EVOLUTION_AGENT_CMD`：`npm ci` 之后、构建之前，在 worktree 内执行（并写入 `.evolution/` 摘录与约束文件）。
 * 测试通过后默认在 worktree 内 `git rebase` 目标分支；冲突时可用 `EVOLUTION_REBASE_CONFLICT_CMD` / Codex 等多轮修复后再 merge 主仓（见 .env.example）。
 * 可选质量链路：`EVOLUTION_PLAN_CMD`（如 Codex 写 `.evolution/dev-plan.md`）→ `EVOLUTION_AGENT_CMD` 开发 → 构建后可选 `EVOLUTION_TEST_AGENT_CMD`（推荐 Gemini）补强测试 → `EVOLUTION_TEST_CMD` → 通过后 `EVOLUTION_REVIEW_CMD` 与 `EVOLUTION_REFINE_CMD` 循环直至 APPROVE。
 *
 * 输入过长防护（避免 CLI `Argument list too long` / 模型拒收）：
 *   `EVOLUTION_AGENT_EXCERPT_MAX_CHARS`、`EVOLUTION_AGENT_CONSTRAINTS_MAX_CHARS`、
 *   `EVOLUTION_AGENT_PLAN_MAX_CHARS`、`EVOLUTION_AGENT_CLI_PROMPT_MAX_CHARS`（注入 `AI_FIX_PROMPT` 的总长上限）。
 *
 * 本轮 inbox 条目全部跑完后可选发布展示站：`EVOLUTION_SHOWCASE_AUTO_DEPLOY`、`EVOLUTION_SHOWCASE_DEPLOY_DIR`、
 * `EVOLUTION_SHOWCASE_GIT_PUSH`、`EVOLUTION_SHOWCASE_GIT_REMOTE_BRANCH`（push 前 pull --rebase）、
 * `EVOLUTION_SHOWCASE_PAGES_GIT_URL` 等（见 `scripts/evolution/showcase-deploy.mjs`）。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { EVOLUTION_DISABLED_CODE, considerEvolutionSchedule } from '../packages/core/src/evolution/surface.ts';
import {
  enrichEnv,
  posixShell,
  run as runProcess,
  sh as shProcess,
  truthy
} from './evolution/process.mjs';
import {
  dedupeInboxItems,
  loadProcessedSlugs as loadProcessedSlugsImpl,
  makeSlug,
  parseInboxItems,
  pickInboxFile as pickInboxFileImpl,
  utcDateString,
  utcDateTimeString
} from './evolution/inbox-loader.mjs';
import {
  getProgressFilePath as getProgressFilePathImpl,
  loadProgress as loadProgressImpl,
  saveProgress as saveProgressImpl
} from './evolution/progress.mjs';
import { deployShowcase } from './evolution/showcase-deploy.mjs';
import { tagCapabilities } from './evolution/capability-tagger.mjs';
import {
  appendOrchestrationEvent,
  appendOrchestrationStep,
  createOrchestrationRunForItem,
  updateOrchestrationRunStatus
} from './evolution/evolution-orchestrator-bridge.mjs';
import { checkMergeGate, writeBacklogEntry } from './evolution/merge-gate.mjs';
import {
  DEFAULT_LINK_FETCH_MS,
  TEST_FAIL_TRACE_CHARS,
  clampAgentCliPrompt,
  envPositiveInt,
  maxEvolutionConcurrencyFromEnv,
  tailForLog,
  truncateAgentText,
  truncateAgentTextFile
} from './evolution/agent-prompts.mjs';
import {
  buildEvolutionEnvFile,
  copyEnvToWorktree as copyEnvToWorktreeImpl,
  copyGatewayConfigToWorktree as copyGatewayConfigToWorktreeImpl,
  removeWorktree as removeWorktreeImpl,
  resolveGatewayConfigSourcePath as resolveGatewayConfigSourcePathImpl
} from './evolution/worktree.mjs';
import { runReviewRefineLoop as runReviewRefineLoopImpl } from './evolution/review-refine.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');
loadDotenv({ path: join(repoRoot, '.env') });

// `evolution/process.mjs` exports take repoRoot explicitly; keep the original
// no-arg signatures the rest of this file relies on.
function run(cmd, args, opts = {}) {
  return runProcess(repoRoot, cmd, args, opts);
}
function sh(cmd, cwd, opts = {}) {
  return shProcess(repoRoot, cmd, cwd, opts);
}
function pickInboxFile() { return pickInboxFileImpl(repoRoot); }
function loadProcessedSlugs() { return loadProcessedSlugsImpl(repoRoot); }
function getProgressFilePath() { return getProgressFilePathImpl(repoRoot); }
function loadProgress() { return loadProgressImpl(repoRoot); }
function saveProgress(progress) { return saveProgressImpl(repoRoot, progress); }
function copyEnvToWorktree(wtPath, itemTrace) {
  return copyEnvToWorktreeImpl(repoRoot, wtPath, itemTrace);
}
function copyGatewayConfigToWorktree(wtPath, itemTrace) {
  return copyGatewayConfigToWorktreeImpl(repoRoot, wtPath, itemTrace);
}
function resolveGatewayConfigSourcePath() {
  return resolveGatewayConfigSourcePathImpl(repoRoot);
}
function removeWorktree(wtPath, branch = '', itemTrace = () => {}, deleteBranch = true) {
  return removeWorktreeImpl(repoRoot, wtPath, branch, itemTrace, deleteBranch);
}

/**
 * 与 `packages/core/test/self-heal-policy.test.js` 中 defaults 用例一致：run-day 子进程会继承宿主
 * loadDotenv 后的 `RAW_AGENT_SELF_HEAL_*`，导致 `normalizeSelfHealPolicy({})` 与默认断言不一致。
 * 跑 `EVOLUTION_TEST_CMD` 时默认剥离这些变量，使结果与「干净」CI 一致；需保留时设 `EVOLUTION_PRESERVE_SELF_HEAL_ENV=1`。
 */
const SELF_HEAL_ENV_KEYS_FOR_STRIP = [
  'RAW_AGENT_SELF_HEAL_TEST_PRESET',
  'RAW_AGENT_SELF_HEAL_MAX_ITERATIONS',
  'RAW_AGENT_SELF_HEAL_AUTO_MERGE',
  'RAW_AGENT_SELF_HEAL_AUTO_RESTART',
  'RAW_AGENT_SELF_HEAL_CUSTOM_SCRIPT',
  'RAW_AGENT_SELF_HEAL_AGENT_ID',
  'RAW_AGENT_SELF_HEAL_TARGET_BRANCH',
  'RAW_AGENT_SELF_HEAL_ALLOW_EXTERNAL_AI'
];

function enrichEnvForRunDayTests() {
  const e = { ...enrichEnv() };
  if (truthy(process.env.EVOLUTION_PRESERVE_SELF_HEAL_ENV)) return e;
  for (const k of SELF_HEAL_ENV_KEYS_FOR_STRIP) {
    delete e[k];
  }
  return e;
}

/** `EVOLUTION_CONCURRENCY` 上限与未设置时的默认值（条目共行跑 worktree）；更大上限设 `EVOLUTION_CONCURRENCY_MAX`（硬顶见 `EVOLUTION_CONCURRENCY_HARD_CAP`）。 */
const MAX_EVOLUTION_CONCURRENCY = maxEvolutionConcurrencyFromEnv();

/**
 * 检查主分支是否有未提交改动（仅当 EVOLUTION_AUTO_MERGE=1 时需要严格检查）。
 * 返回 { dirty: boolean, files: string[] }
 */
async function checkMainBranchDirty() {
  const { code, out } = await run('git', ['status', '--porcelain'], { cwd: repoRoot });
  if (code !== 0) return { dirty: false, files: [] };
  const files = out.trim().split('\n').filter(Boolean);
  return { dirty: files.length > 0, files };
}

/** `file://`：读本地 .md（如 Obsidian 经 evolution:learn 摄入）；`http(s)`: 去 HTML 抓正文。失败不阻断后续测试。 */
function fetchLocalFileExcerpt(url) {
  try {
    const p = fileURLToPath(url);
    if (!existsSync(p)) {
      return { ok: false, error: 'local file not found', excerpt: '' };
    }
    const cap = Math.max(2000, envPositiveInt('EVOLUTION_AGENT_EXCERPT_MAX_CHARS', 22_000));
    const raw = readFileSync(p, 'utf8');
    return { ok: true, excerpt: raw.slice(0, cap) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, excerpt: '' };
  }
}

/** 抓取 inbox 链接的正文（去 HTML 或读本地 .md），供「完整阅读」对照；失败不阻断后续测试。 */
async function fetchSourceExcerpt(url) {
  if (typeof url === 'string' && url.startsWith('file:')) {
    return fetchLocalFileExcerpt(url);
  }
  const ms = Math.max(3000, Number(process.env.EVOLUTION_LINK_FETCH_MS ?? DEFAULT_LINK_FETCH_MS) || DEFAULT_LINK_FETCH_MS);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'evolution-run-day/0.1 (+https://github.com)' },
      redirect: 'follow'
    });
    clearTimeout(t);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, excerpt: '' };
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const cap = Math.max(2000, envPositiveInt('EVOLUTION_AGENT_EXCERPT_MAX_CHARS', 22_000));
    const raw = await res.text();
    if (ct.includes('application/json')) {
      return { ok: true, excerpt: raw.slice(0, cap) };
    }
    const stripped = raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: true, excerpt: stripped.slice(0, cap) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, excerpt: '' };
  }
}

/** 有限并发执行 async 任务（并发度由 `limit` 决定）。 */
async function runPool(items, limit, worker) {
  const n = items.length;
  if (n === 0) return;
  const cap = Math.max(1, Math.min(limit, n));
  let next = 0;
  const runWorker = async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= n) return;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: cap }, () => runWorker()));
}

/**
 * 串行化对主仓 `repoRoot` 的 checkout/merge，避免多路并发时竞态。
 * 构建与测试仍在各自 worktree 内并行。
 */
function createMergeMutex() {
  let tail = Promise.resolve();
  return function withMergeLock(fn) {
    const p = tail.then(() => fn());
    tail = p.catch(() => {}).then(() => {});
    return p;
  };
}

async function gitClean() {
  const { code, out } = await run('git', ['status', '--porcelain'], { cwd: repoRoot });
  if (code !== 0) return false;
  return out.trim().length === 0;
}

async function writeFailureDoc({
  slug,
  title,
  link,
  branch,
  testCmd,
  errTail,
  analysis,
  sourceExcerpt,
  sourceFetchError,
  agentHookCmd = '',
  agentHookSection = ''
}) {
  const dir = join(repoRoot, 'doc', 'evolution', 'failure');
  await mkdir(dir, { recursive: true });
  const name = `${utcDateString(new Date())}-${slug}.md`;
  const p = join(dir, name);
  const excerptBlock =
    sourceFetchError && !sourceExcerpt
      ? `_抓取来源正文失败：${sourceFetchError}_\n`
      : sourceExcerpt
        ? `\`\`\`\n${sourceExcerpt.slice(0, 16000)}\n\`\`\`\n`
        : '_（无正文摘录）_\n';
  const body = `---
status: failure
source_url: ${JSON.stringify(link)}
source_title: ${JSON.stringify(title)}
experiment_branch: ${JSON.stringify(branch)}
test_command: ${JSON.stringify(testCmd)}
date_utc: ${JSON.stringify(new Date().toISOString())}
${makeExtraFrontmatter(title, link)}
---

# 实验失败：${title}

## 来源
- [${title}](${link})

## 来源正文摘录（抓取）
${excerptBlock}

## 分支
\`${branch}\`

## 测试命令
\`${testCmd}\`

${agentHookSection}
## 失败输出（摘录）

\`\`\`
${errTail.slice(0, 16000)}
\`\`\`

## 原因分析

${analysis}
`;
  await writeFile(p, body, 'utf8');
  console.error(`evolution-run-day: wrote ${p}`);
}

async function writeSuccessDoc({
  slug,
  title,
  link,
  branch,
  testCmd,
  outTail,
  merged,
  mergeCommit,
  sourceExcerpt,
  sourceFetchError,
  agentHookCmd = '',
  agentHookOut = '',
  gitDiffStat = '',
  changeClassification = null
}) {
  const dir = join(repoRoot, 'doc', 'evolution', 'success');
  await mkdir(dir, { recursive: true });
  const name = `${utcDateString(new Date())}-${slug}.md`;
  const p = join(dir, name);
  const excerptBlock =
    sourceFetchError && !sourceExcerpt
      ? `_抓取来源正文失败：${sourceFetchError}_\n`
      : sourceExcerpt
        ? `\`\`\`\n${sourceExcerpt.slice(0, 12000)}\n\`\`\`\n`
        : '_（无正文摘录）_\n';
  const classSection = changeClassification
    ? `feature_paths_count: ${changeClassification.featurePaths.length}\nnon_feature_paths_count: ${changeClassification.nonFeaturePaths.length}\n`
    : '';
  const body = `---
status: success
source_url: ${JSON.stringify(link)}
source_title: ${JSON.stringify(title)}
experiment_branch: ${JSON.stringify(branch)}
test_command: ${JSON.stringify(testCmd)}
merged: ${merged}
merge_commit: ${JSON.stringify(mergeCommit || '')}
${classSection}date_utc: ${JSON.stringify(new Date().toISOString())}
${makeExtraFrontmatter(title, link)}
---

# 实验成功：${title}

## 来源
- [${title}](${link})

## 来源正文摘录（抓取）
${excerptBlock}

## 实验分支
\`${branch}\`

## 测试命令
\`${testCmd}\`

${agentHookCmd ? `## Agent 钩子\n\n命令：${JSON.stringify(agentHookCmd)}\n\n\`\`\`\n${(agentHookOut || '(无输出)').slice(0, 8000)}\n\`\`\`\n\n` : ''}${gitDiffStat ? `## worktree 变更（git diff --stat / status）\n\n\`\`\`\n${gitDiffStat.slice(0, 8000)}\n\`\`\`\n\n` : ''}${changeClassification ? `## 变更分类\n- 功能源码文件：**${changeClassification.featurePaths.length} 个**\n${changeClassification.featurePaths.map((f) => `  - \`${f}\``).join('\n') || '  _（无）_'}\n- 其他文件（测试/文档等）：**${changeClassification.nonFeaturePaths.length} 个**\n\n` : ''}## 输出摘要

\`\`\`
${outTail.slice(0, 12000)}
\`\`\`

## 合并

${merged ? `已合并。Commit: ${mergeCommit || '(see git log)'}` : `未自动合并（EVOLUTION_AUTO_MERGE=0）；请在主仓手动 \`git merge ${branch}\``}
`;
  await writeFile(p, body, 'utf8');
  console.log(`evolution-run-day: wrote ${p}`);
}

function getAgentConstraintsText() {
  const fileRel = process.env.EVOLUTION_AGENT_CONSTRAINTS_FILE?.trim();
  if (fileRel) {
    const abs = fileRel.startsWith('/') ? fileRel : join(repoRoot, fileRel);
    if (existsSync(abs)) {
      try {
        return readFileSync(abs, 'utf8');
      } catch {
        return '';
      }
    }
  }
  const inline = process.env.EVOLUTION_AGENT_CONSTRAINTS;
  if (inline != null && String(inline).trim()) return String(inline);
  return '';
}

async function prepareAgentContext(wtPath, bundle) {
  const dir = join(wtPath, '.evolution');
  await mkdir(dir, { recursive: true });
  const excerptFile = join(dir, 'source-excerpt.txt');
  const constraintsFile = join(dir, 'constraints.txt');
  const excerptMax = Math.max(2000, envPositiveInt('EVOLUTION_AGENT_EXCERPT_MAX_CHARS', 22_000));
  const constraintsMax = Math.max(1000, envPositiveInt('EVOLUTION_AGENT_CONSTRAINTS_MAX_CHARS', 24_000));

  const b =
    typeof bundle === 'string'
      ? { excerpt: bundle, title: '', link: '', fetchError: '' }
      : {
          excerpt: bundle?.excerpt ?? '',
          title: bundle?.title ?? '',
          link: bundle?.link ?? '',
          fetchError: bundle?.fetchError ?? ''
        };

  const lead = [];
  if (b.title || b.link) {
    lead.push('## Source context (inbox + URL)');
    if (b.title) lead.push(`**Title:** ${b.title}`);
    if (b.link) lead.push(`**URL:** ${b.link}`);
    if (b.fetchError) lead.push(`**Body fetch:** ${b.fetchError}`);
    lead.push('');
  }
  if (b.excerpt) {
    lead.push('## Fetched body excerpt');
    lead.push(b.excerpt);
  } else if (b.title || b.link) {
    lead.push(
      '## Fetched body excerpt\n_(empty or failed — research may still use title/URL above to judge a bounded improvement.)_'
    );
  }

  const combined = lead.join('\n').trim();
  const ex = truncateAgentText(combined || b.excerpt || '', excerptMax, 'source excerpt');
  const co = truncateAgentText(getAgentConstraintsText(), constraintsMax, 'constraints');
  await writeFile(excerptFile, ex, 'utf8');
  await writeFile(constraintsFile, co, 'utf8');
  return { excerptFile, constraintsFile, dir };
}

function envForAgentHook(wtPath, title, link, excerptFile, constraintsFile, arg6 = '', arg7 = {}) {
  let fetchNote = '';
  let extraEnv = {};
  if (arg6 != null && typeof arg6 === 'object' && !Array.isArray(arg6)) {
    extraEnv = arg6;
  } else {
    fetchNote = typeof arg6 === 'string' ? arg6 : '';
    extraEnv = arg7 && typeof arg7 === 'object' && !Array.isArray(arg7) ? arg7 : {};
  }
  const planPath = join(wtPath, '.evolution', 'dev-plan.md');
  const base = {
    ...enrichEnv(),
    EVOLUTION_WT_ROOT: wtPath,
    EVOLUTION_WORKTREE: wtPath,
    EVOLUTION_SOURCE_TITLE: title,
    EVOLUTION_SOURCE_URL: link,
    EVOLUTION_SOURCE_FETCH_NOTE: fetchNote || '',
    EVOLUTION_SOURCE_EXCERPT_FILE: excerptFile,
    EVOLUTION_AGENT_CONSTRAINTS_FILE: constraintsFile
  };
  if (existsSync(planPath)) {
    base.EVOLUTION_PLAN_FILE = planPath;
  }
  return { ...base, ...extraEnv };
}

async function getWorktreeDiffVsBase(wtPath, targetBranch, maxChars) {
  const d = await run('git', ['diff', `${targetBranch}...HEAD`], { cwd: wtPath });
  let text = d.code === 0 ? d.out : '';
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n...[diff truncated at ${maxChars} chars]`;
  }
  return text || '_(empty diff vs base — no commits or no changes)_\n';
}

function parseReviewVerdict(wtPath) {
  const p = join(wtPath, '.evolution', 'review-verdict.txt');
  if (!existsSync(p)) return null;
  const first = readFileSync(p, 'utf8').trim().split(/\r?\n/)[0]?.trim().toUpperCase() || '';
  if (!first) return null;
  if (first.startsWith('APPROVE') || first === 'LGTM' || first === 'PASS' || first.startsWith('PASS ')) {
    return 'approve';
  }
  if (
    first.startsWith('NEEDS_WORK') ||
    first.startsWith('NEEDS WORK') ||
    first === 'CHANGES_REQUESTED' ||
    first.startsWith('REQUEST_CHANGES')
  ) {
    return 'needs_work';
  }
  return 'unknown';
}

async function clearReviewArtifacts(wtPath) {
  for (const f of ['review-verdict.txt', 'review-feedback.md']) {
    try {
      await unlink(join(wtPath, '.evolution', f));
    } catch {
      /* ok */
    }
  }
}

/**
 * 提交 worktree 内改动，排除 `.evolution/`（规划/审查产物不入库）。
 */
async function commitWorktreeChangesExcludingEvolution(wtPath, message, itemTrace) {
  const stPor = await run('git', ['status', '--porcelain'], { cwd: wtPath });
  if (!stPor.out.trim()) {
    return { committed: false, code: 0, reason: 'no_changes', out: '', err: '' };
  }
  await run('git', ['add', '-A', '--', '.', ':!.evolution'], { cwd: wtPath });
  const stStaged = await run('git', ['diff', '--cached', '--name-only'], { cwd: wtPath });
  if (!stStaged.out.trim()) {
    itemTrace('仅 .evolution 等排除路径有改动，跳过 commit');
    return { committed: false, code: 0, reason: 'no_changes', out: '', err: '' };
  }
  const cm = await run('git', ['commit', '-m', message], { cwd: wtPath });
  itemTrace(`git commit → exit=${cm.code} (${message.slice(0, 70)}${message.length > 70 ? '…' : ''})`);
  return {
    committed: cm.code === 0,
    code: cm.code,
    reason: cm.code === 0 ? 'committed' : 'commit_failed',
    out: cm.out,
    err: cm.err
  };
}

/**
 * Codex 审查 → 未通过则 Claude/Codex 精炼 → 再测，循环直至 APPROVE 或达上限。
 */
/**
 * Thin facade over `scripts/evolution/review-refine.mjs` — wires the orchestrator's
 * private helpers into the extracted loop without changing call sites.
 */
function runReviewRefineLoop(opts) {
  return runReviewRefineLoopImpl(opts, {
    sh,
    clampAgentCliPrompt,
    enrichEnvForRunDayTests,
    resolveAgentCmdForWorktree,
    envForAgentHook,
    clearReviewArtifacts,
    getWorktreeDiffVsBase,
    parseReviewVerdict,
    commitWorktreeChangesExcludingEvolution
  });
}


async function captureGitWorktreeDiff(wtPath) {
  const st = await run('git', ['diff', '--stat'], { cwd: wtPath });
  const por = await run('git', ['status', '--porcelain'], { cwd: wtPath });
  const parts = [];
  if (st.code === 0 && st.out.trim()) parts.push(st.out.trim());
  if (por.code === 0 && por.out.trim()) parts.push(por.out.trim());
  return parts.join('\n\n');
}

/**
 * 判断一个变更路径是否属于"实际功能源码"（packages/ 或 apps/ 下的非测试文件）。
 * 仅测试文件、文档、.evolution/ 等不算实际功能改动。
 */
function isFeaturePath(p) {
  if (!/^(packages|apps)[/\\]/.test(p)) return false;
  if (/[/\\]test[/\\]/i.test(p)) return false;
  if (/[/\\]__tests__[/\\]/i.test(p)) return false;
  if (/\.(test|spec)\.[jt]sx?$/.test(p)) return false;
  return true;
}

/**
 * 比较 worktree HEAD 与 targetBranch，将变更文件分类为功能文件 vs 非功能文件。
 * 在 removeWorktree 之前调用（worktree 仍存在时）。
 */
async function classifyBranchChanges(wtPath, targetBranch) {
  const result = await run('git', ['diff', '--name-only', `${targetBranch}..HEAD`], { cwd: wtPath });
  const allPaths = result.code === 0 ? result.out.trim().split('\n').filter(Boolean) : [];
  const featurePaths = allPaths.filter(isFeaturePath);
  const nonFeaturePaths = allPaths.filter((p) => !isFeaturePath(p));
  return { featurePaths, nonFeaturePaths, allPaths, hasFeatureChanges: featurePaths.length > 0 };
}

async function writeSkipDoc({
  slug,
  title,
  link,
  branch,
  testCmd,
  skipReason,
  featurePaths,
  nonFeaturePaths,
  sourceExcerpt,
  sourceFetchError,
  agentHookCmd = '',
  gitDiffStat = ''
}) {
  const dir = join(repoRoot, 'doc', 'evolution', 'skip');
  await mkdir(dir, { recursive: true });
  const name = `${utcDateString(new Date())}-${slug}.md`;
  const p = join(dir, name);
  const excerptBlock =
    sourceFetchError && !sourceExcerpt
      ? `_抓取来源正文失败：${sourceFetchError}_\n`
      : sourceExcerpt
        ? `\`\`\`\n${sourceExcerpt.slice(0, 8000)}\n\`\`\`\n`
        : '_（无正文摘录）_\n';
  const body = `---
status: skip
source_url: ${JSON.stringify(link)}
source_title: ${JSON.stringify(title)}
experiment_branch: ${JSON.stringify(branch)}
test_command: ${JSON.stringify(testCmd)}
skip_reason: ${JSON.stringify(skipReason)}
feature_paths_count: ${featurePaths.length}
non_feature_paths_count: ${nonFeaturePaths.length}
date_utc: ${JSON.stringify(new Date().toISOString())}
${makeExtraFrontmatter(title, link)}
---

# 实验跳过（无功能源码改动）：${title}

## 来源
- [${title}](${link})

## 来源正文摘录（抓取）
${excerptBlock}

## 分支
\`${branch}\`

## 跳过原因
${skipReason}

## 变更分类
- 功能源码文件（packages/apps 下非测试）：**${featurePaths.length} 个**
${featurePaths.length > 0 ? featurePaths.map((f) => `  - \`${f}\``).join('\n') : '  _（无）_'}
- 其他文件（测试/文档等）：**${nonFeaturePaths.length} 个**
${nonFeaturePaths.length > 0 ? nonFeaturePaths.map((f) => `  - \`${f}\``).join('\n') : '  _（无）_'}

${agentHookCmd ? `## Agent 钩子\n命令：${JSON.stringify(agentHookCmd)}\n\n` : ''}${gitDiffStat ? `## worktree 变更（git diff --stat / status）\n\n\`\`\`\n${gitDiffStat.slice(0, 4000)}\n\`\`\`\n\n` : ''}## 测试命令
\`${testCmd}\`（测试已通过，但未合并）
`;
  await writeFile(p, body, 'utf8');
  console.log(`evolution-run-day: wrote ${p}`);
}

async function writeNoOpDoc({
  slug,
  title,
  link,
  branch,
  noOpReason,
  sourceExcerpt,
  sourceFetchError,
  researchCmd = '',
  researchOut = ''
}) {
  const dir = join(repoRoot, 'doc', 'evolution', 'no-op');
  await mkdir(dir, { recursive: true });
  const name = `${utcDateString(new Date())}-${slug}.md`;
  const p = join(dir, name);
  const excerptBlock =
    sourceFetchError && !sourceExcerpt
      ? `_抓取来源正文失败：${sourceFetchError}_\n`
      : sourceExcerpt
        ? `\`\`\`\n${sourceExcerpt.slice(0, 6000)}\n\`\`\`\n`
        : '_（无正文摘录）_\n';
  const body = `---
status: no-op
source_url: ${JSON.stringify(link)}
source_title: ${JSON.stringify(title)}
experiment_branch: ${JSON.stringify(branch)}
no_op_reason: ${JSON.stringify(noOpReason)}
date_utc: ${JSON.stringify(new Date().toISOString())}
${makeExtraFrontmatter(title, link)}
---

# 研究阶段：无改进机会 — ${title}

## 来源
- [${title}](${link})

## 来源正文摘录
${excerptBlock}

## 研究结论
${noOpReason}

## 处置
- 分支 \`${branch}\` 已删除（研究阶段决策，无需保留）
- 若认为应重新考虑，可从 \`${link}\` 重新触发

${researchCmd ? `## 研究命令\n\`${researchCmd}\`\n\n` : ''}${researchOut ? `## 研究输出（摘录）\n\`\`\`\n${researchOut.slice(0, 3000)}\n\`\`\`\n` : ''}`;
  await writeFile(p, body, 'utf8');
  console.log(`evolution-run-day: wrote ${p}`);
}

/**
 * 跳过类型的中文描述映射
 */
const SKIP_TYPE_LABELS = {
  SUPERSEDED: '当前实现更优',
  DUPLICATE: '已有类似实现',
  IRRELEVANT: '与项目无关',
  OUTDATED: '内容已过时',
  TOO_COMPLEX: '改动过于复杂'
};

/**
 * 写入研究阶段评估记录（区分不同跳过类型）。
 * SUPERSEDED/DUPLICATE 写入 superseded/ 目录
 * IRRELEVANT/OUTDATED/TOO_COMPLEX 写入 no-op/ 目录
 */
async function writeResearchDecisionDoc({
  slug,
  title,
  link,
  branch,
  decision,
  skipType = '',
  reason,
  sourceExcerpt,
  sourceFetchError,
  researchCmd = '',
  researchOut = ''
}) {
  // SUPERSEDED 和 DUPLICATE 单独目录，便于后续回顾"我们为什么拒绝"
  const isSuperseded = skipType === 'SUPERSEDED' || skipType === 'DUPLICATE';
  const dir = isSuperseded
    ? join(repoRoot, 'doc', 'evolution', 'superseded')
    : join(repoRoot, 'doc', 'evolution', 'no-op');

  await mkdir(dir, { recursive: true });
  const name = `${utcDateString(new Date())}-${slug}.md`;
  const p = join(dir, name);

  const excerptBlock =
    sourceFetchError && !sourceExcerpt
      ? `_抓取来源正文失败：${sourceFetchError}_\n`
      : sourceExcerpt
        ? `\`\`\`\n${sourceExcerpt.slice(0, 6000)}\n\`\`\`\n`
        : '_（无正文摘录）_\n';

  const skipTypeLabel = SKIP_TYPE_LABELS[skipType] || skipType || '无改进机会';
  const status = isSuperseded ? 'superseded' : 'no-op';

  const body = `---
status: ${status}
source_url: ${JSON.stringify(link)}
source_title: ${JSON.stringify(title)}
skip_type: ${JSON.stringify(skipType || 'none')}
date_utc: ${JSON.stringify(new Date().toISOString())}
${makeExtraFrontmatter(title, link)}
---

# 研究评估：${skipTypeLabel} — ${title}

## 来源
- [${title}](${link})

## 来源正文摘录
${excerptBlock}

## 评估结论

**决策：${decision}**${skipType ? `（${skipTypeLabel}）` : ''}

${reason}

## 当前项目状态
${skipType === 'SUPERSEDED' ? '当前项目已有更优实现，无需参考此资料。' : ''}${skipType === 'DUPLICATE' ? '当前项目已包含类似功能，无需重复实现。' : ''}${skipType === 'IRRELEVANT' ? '此资料与当前项目方向不符。' : ''}${skipType === 'OUTDATED' ? '此资料描述的方法已过时，不推荐采用。' : ''}${skipType === 'TOO_COMPLEX' ? '此改动需要大规模重构，不适合自动进化流程。' : ''}

${researchCmd ? `## 研究命令\n\`${researchCmd}\`\n\n` : ''}${researchOut ? `## 研究输出（摘录）\n\`\`\`\n${researchOut.slice(0, 3000)}\n\`\`\`\n` : ''}`;

  await writeFile(p, body, 'utf8');
  console.log(`evolution-run-day: wrote ${p}`);
}

/**
 * 选择用于 **rebase 冲突** 的 agent 命令（在 worktree cwd 下执行）。
 * 优先级：EVOLUTION_REBASE_CONFLICT_CMD → EVOLUTION_AGENT_CMD →（可选）本仓 Codex 包装脚本 + PATH 含 codex。
 */
async function pickRebaseConflictAgentCmd(wtPath, itemTrace) {
  const explicit = process.env.EVOLUTION_REBASE_CONFLICT_CMD?.trim();
  if (explicit) {
    const { run: cmd, note } = resolveAgentCmdForWorktree(wtPath, explicit);
    if (note) itemTrace(note);
    return cmd;
  }
  const agent = process.env.EVOLUTION_AGENT_CMD?.trim();
  if (agent) {
    const { run: cmd, note } = resolveAgentCmdForWorktree(wtPath, agent);
    if (note) itemTrace(note);
    return cmd;
  }
  if (truthy(process.env.EVOLUTION_REBASE_DISABLE_CODEX_DEFAULT)) return '';
  const codexScript = join(repoRoot, 'scripts', 'evolution-rebase-conflict-codex.sh');
  if (!existsSync(codexScript)) return '';
  const hv = await sh('command -v codex >/dev/null 2>&1', repoRoot);
  if (hv.code !== 0) return '';
  itemTrace(
    'rebase 冲突：未配置 EVOLUTION_REBASE_CONFLICT_CMD / EVOLUTION_AGENT_CMD，使用默认 Codex（scripts/evolution-rebase-conflict-codex.sh）'
  );
  return `bash ${codexScript}`;
}

/**
 * 在指定 cwd 调用 agent 清除冲突标记并 `git add -A`。
 * @param {'merge' | 'rebase'} kind — merge：仅 EVOLUTION_AGENT_CMD；rebase：见 pickRebaseConflictAgentCmd。
 */
async function resolveConflictsWithAgentInCwd(cwd, conflictInfo, itemTrace, kind) {
  let agentRunCmd = '';
  if (kind === 'rebase') {
    agentRunCmd = await pickRebaseConflictAgentCmd(cwd, itemTrace);
    if (!agentRunCmd) {
      itemTrace(
        '无可用 rebase 冲突解决命令（可设 EVOLUTION_REBASE_CONFLICT_CMD 或 EVOLUTION_AGENT_CMD，或安装 codex 并勿设 EVOLUTION_REBASE_DISABLE_CODEX_DEFAULT=1）'
      );
      return false;
    }
  } else {
    const rawAgentCmd = process.env.EVOLUTION_AGENT_CMD?.trim() || '';
    if (!rawAgentCmd) {
      itemTrace('未设置 EVOLUTION_AGENT_CMD，跳过冲突自动解决');
      return false;
    }
    const resolved = resolveAgentCmdForWorktree(cwd, rawAgentCmd);
    agentRunCmd = resolved.run;
    if (resolved.note) itemTrace(resolved.note);
  }

  const where =
    kind === 'rebase'
      ? `the git worktree (rebase in progress) at: ${cwd}`
      : `the git repository at: ${cwd}`;
  const task =
    kind === 'rebase'
      ? 'Git rebase is paused due to merge conflicts. Your ONLY task is to resolve ALL conflict markers in the affected files.\n'
      : 'There are merge conflicts. Your ONLY task is to resolve ALL conflict markers in the affected files.\n';
  const prompt = clampAgentCliPrompt(
    `You are in ${where}.\n` +
      task +
      `Rules:\n` +
      `- Remove every <<<<<<<, =======, >>>>>>> block by choosing the correct content.\n` +
      `- Do NOT add new features or refactors.\n` +
      `- After editing, run: git add -A\n` +
      `- Do NOT run git commit.\n` +
      (kind === 'rebase' ? `- Do NOT run git rebase --continue` : '') +
      `\n\nConflict details:\n${conflictInfo}`,
    `merge-conflict-${kind}`
  );

  const hookEnv = {
    ...enrichEnv(),
    EVOLUTION_WORKTREE: cwd,
    EVOLUTION_WT_ROOT: cwd,
    AI_FIX_PROMPT: prompt
  };
  const tResolve = Date.now();
  itemTrace(`冲突解决 agent 启动（${kind}，${agentRunCmd.slice(0, 80)}）…`);
  const res = await sh(agentRunCmd, cwd, { env: hookEnv });
  itemTrace(`冲突解决 agent → exit=${res.code} (${Date.now() - tResolve}ms)`);
  if (res.code !== 0) {
    itemTrace(`agent 退出非零: ${tailForLog(res.out + res.err)}`);
    return false;
  }
  const remaining = await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd });
  if (remaining.out.trim()) {
    itemTrace(`仍有未解决冲突文件: ${remaining.out.trim().slice(0, 300)}`);
    return false;
  }
  await run('git', ['add', '-A'], { cwd });
  return true;
}

/**
 * 当 `git merge` 失败有冲突时，调用 `EVOLUTION_AGENT_CMD` 在主仓 cwd 解决冲突文件，
 * 再 `git add -A`；由调用方完成 commit。
 * 返回 true 表示冲突已清除，false 表示解决失败。
 */
async function resolveConflictsWithAgent(conflictInfo, itemTrace) {
  return resolveConflictsWithAgentInCwd(repoRoot, conflictInfo, itemTrace, 'merge');
}

/**
 * 在 worktree 内 rebase 到 targetBranch；遇冲突则循环调用 agent 修复后 `git rebase --continue`。
 */
async function rebaseWorktreeOntoWithAgentFixes(wtPath, targetBranch, itemTrace) {
  const maxRounds = Math.max(1, Number(process.env.EVOLUTION_REBASE_CONFLICT_MAX_ROUNDS ?? 8) || 8);
  const gitEditorEnv = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };

  let rb = await run('git', ['rebase', targetBranch], { cwd: wtPath });
  if (rb.code === 0) {
    itemTrace(`git rebase ${targetBranch} → 成功`);
    return true;
  }

  let unmerged = await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: wtPath });
  if (!unmerged.out.trim()) {
    itemTrace(`rebase 失败且无未合并文件，abort: ${tailForLog(rb.out + rb.err)}`);
    await run('git', ['rebase', '--abort'], { cwd: wtPath }).catch(() => {});
    return false;
  }

  for (let round = 0; round < maxRounds; round++) {
    itemTrace(`rebase 冲突处理 ${round + 1}/${maxRounds}`);
    const st = await run('git', ['status', '--short'], { cwd: wtPath });
    const detail = `git rebase onto ${targetBranch} paused on conflicts.\n\n${rb.out}\n${rb.err}\n\nstatus:\n${st.out}\n\nunmerged:\n${unmerged.out.trim()}`;

    const resolved = await resolveConflictsWithAgentInCwd(wtPath, detail, itemTrace, 'rebase');
    if (!resolved) {
      await run('git', ['rebase', '--abort'], { cwd: wtPath }).catch(() => {});
      return false;
    }

    const cont = await run('git', ['rebase', '--continue'], { cwd: wtPath, env: gitEditorEnv });
    if (cont.code === 0) {
      itemTrace('git rebase --continue → 成功，rebase 完成');
      return true;
    }

    unmerged = await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: wtPath });
    if (!unmerged.out.trim()) {
      itemTrace(`git rebase --continue 失败且无未合并文件: ${tailForLog(cont.out + cont.err)}`);
      await run('git', ['rebase', '--abort'], { cwd: wtPath }).catch(() => {});
      return false;
    }
    rb = cont;
  }

  itemTrace(`rebase 冲突超过 EVOLUTION_REBASE_CONFLICT_MAX_ROUNDS=${maxRounds}，abort`);
  await run('git', ['rebase', '--abort'], { cwd: wtPath }).catch(() => {});
  return false;
}

/**
 * worktree 只含已提交文件；未 commit 的 `scripts/*.sh` 在 worktree 里不存在 → bash 报 127。
 * 若相对路径脚本在主仓工作区存在，则改为绝对路径执行（仍保持 cwd=worktree）。
 */
function resolveAgentCmdForWorktree(wtPath, cmd) {
  const trimmed = cmd.trim();
  const m = /^(bash|sh)\s+(\S+)(.*)$/.exec(trimmed);
  if (!m) return { run: trimmed, note: '' };
  const shell = m[1];
  let scriptArg = m[2];
  const rest = m[3] ?? '';
  if (scriptArg.startsWith('/')) return { run: trimmed, note: '' };
  const rel = scriptArg.startsWith('./') ? scriptArg.slice(2) : scriptArg;
  const inWt = join(wtPath, rel);
  const inRoot = join(repoRoot, rel);
  if (!existsSync(inWt) && existsSync(inRoot)) {
    return {
      run: `${shell} ${inRoot}${rest}`,
      note: `worktree 内无 ${rel}，已改用主仓脚本（建议 git add/commit 后 worktree 可自包含）`
    };
  }
  return { run: trimmed, note: '' };
}

async function writeRunDayLog(logLines) {
  if (truthy(process.env.EVOLUTION_NO_RUN_LOG)) return;
  const dir = join(repoRoot, 'doc', 'evolution', 'runs');
  await mkdir(dir, { recursive: true });
  const body = `# evolution-run-day 最近一次\n\n${logLines.join('\n')}\n\n（终端亦有相同时间戳行；设 \`EVOLUTION_NO_RUN_LOG=1\` 可禁用本文件）\n`;
  await writeFile(join(dir, 'latest-run-day.md'), body, 'utf8');
}

/** Build extra YAML frontmatter fields for result docs. */
function makeExtraFrontmatter(title = '', link = '') {
  let tagsYaml = '[]';
  try {
    const tags = tagCapabilities({ title, url: link, summary: '' });
    tagsYaml = tags.length > 0 ? `[${tags.map(t => JSON.stringify(t)).join(', ')}]` : '[]';
  } catch { /**/ }
  return `capability_tags: ${tagsYaml}
failure_type: null
risk_level: low
cost_estimate: 0
run_id: ""
agent: ""
model: ""`;
}

/** Append one JSONL run-event line to doc/evolution/runs/YYYY-MM-DD.jsonl. Non-fatal. */
function appendRunEvent(event) {
  try {
    const dir = join(repoRoot, 'doc', 'evolution', 'runs');
    mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    appendFileSync(join(dir, `${date}.jsonl`), JSON.stringify(event) + '\n', 'utf8');
  } catch {
    /* non-fatal */
  }
}

async function main() {
  const decision = considerEvolutionSchedule({ reason: 'cli' });
  if (!decision.started) {
    console.error(`${EVOLUTION_DISABLED_CODE}: Evolution is hidden and will not run.`);
    return;
  }
  const logLines = [];
  const runId = `run-${Date.now()}`;
  const trace = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logLines.push(line);
    console.log(`evolution-run-day: ${line}`);
  };

  // ── 多轮调度配置 ─────────────────────────────────────────────────────
  const roundsPerDay = Math.max(1, Number(process.env.EVOLUTION_ROUNDS_PER_DAY ?? 1) || 1);
  const roundIntervalMs = Math.max(0, Number(process.env.EVOLUTION_ROUND_INTERVAL_MS ?? 0) || 0);
  const allowDirtyMain = truthy(process.env.EVOLUTION_ALLOW_DIRTY_MAIN);

  // 加载进度
  let progress = loadProgress();
  trace(`进度: 今日已完成 ${progress.roundsCompleted} 轮，配置 EVOLUTION_ROUNDS_PER_DAY=${roundsPerDay}`);

  // 检查是否已达到今日轮次上限
  if (progress.roundsCompleted >= roundsPerDay) {
    trace(`结束：今日已完成 ${progress.roundsCompleted} 轮，已达 EVOLUTION_ROUNDS_PER_DAY=${roundsPerDay} 上限`);
    return;
  }

  // ── 主分支脏检测（当 AUTO_MERGE=1 时严格检查）─────────────────────────────
  const autoMerge = truthy(process.env.EVOLUTION_AUTO_MERGE);
  if (autoMerge) {
    const { dirty, files } = await checkMainBranchDirty();
    if (dirty) {
      if (allowDirtyMain) {
        trace(`警告：主分支有 ${files.length} 个未提交改动，但 EVOLUTION_ALLOW_DIRTY_MAIN=1 继续`);
        files.slice(0, 5).forEach((f) => trace(`  - ${f}`));
        if (files.length > 5) trace(`  … 还有 ${files.length - 5} 个文件`);
      } else {
        trace('结束：主分支有未提交改动，无法自动合并');
        console.error('evolution-run-day: Main branch has uncommitted changes. Options:');
        console.error('  1. Commit or stash your changes first');
        console.error('  2. Set EVOLUTION_ALLOW_DIRTY_MAIN=1 to continue with auto-merge (may cause conflicts)');
        console.error('  3. Set EVOLUTION_AUTO_MERGE=0 to skip auto-merge');
        console.error('\nUncommitted files:');
        files.slice(0, 10).forEach((f) => console.error(`  ${f}`));
        if (files.length > 10) console.error(`  … and ${files.length - 10} more`);
        process.exitCode = 1;
        return;
      }
    }
  }

  try {
    trace('启动');
    const inboxPath = pickInboxFile();
    if (!inboxPath) {
      trace('结束：无 inbox，请先执行 npm run evolution:learn');
      return;
    }

    const text = readFileSync(inboxPath, 'utf8');
    const newlyListedItems = dedupeInboxItems(parseInboxItems(text, { section: 'new' }));
    const allItems = newlyListedItems.length > 0 ? newlyListedItems : dedupeInboxItems(parseInboxItems(text));
    const parsedTotal = allItems.length;

    // 过滤已处理条目（success/failure/skip/no-op 目录中已有对应 slug）
    const processedSlugs = loadProcessedSlugs();
    const unprocessed = allItems.filter((it) => !processedSlugs.has(makeSlug(it.title, it.link)));
    const skippedCount = parsedTotal - unprocessed.length;
    if (skippedCount > 0) {
      trace(`已跳过 ${skippedCount} 条已处理条目，剩余 ${unprocessed.length} 条待处理`);
    }

    // EVOLUTION_MAX_ITEMS：可选安全帽（不设或 0 = 全部未处理条目；设正整数 = 每次最多处理 N 条）
    const rawMax = process.env.EVOLUTION_MAX_ITEMS;
    let items;
    if (rawMax !== undefined && rawMax.trim() !== '' && Number(rawMax) > 0) {
      const cap = Number(rawMax);
      items = unprocessed.slice(0, cap);
    } else {
      items = unprocessed;
    }
    if (items.length === 0) {
      trace(`结束：inbox ${parsedTotal} 条全部已处理（如需强制重跑，删除对应 doc/evolution/{success,failure,skip,no-op}/ 文件）`);
      return;
    }
    const max = items.length;

    const allowDirty = truthy(process.env.EVOLUTION_ALLOW_DIRTY_WORKTREE);
    if (!allowDirty && !(await gitClean())) {
      trace('结束：工作区不干净（可设 EVOLUTION_ALLOW_DIRTY_WORKTREE=1）');
      console.error('evolution-run-day: git working tree is not clean (set EVOLUTION_ALLOW_DIRTY_WORKTREE=1 to override)');
      process.exitCode = 1;
      return;
    }

    const targetBranch = process.env.EVOLUTION_TARGET_BRANCH?.trim() || process.env.RAW_AGENT_SELF_HEAL_TARGET_BRANCH?.trim() || 'main';
    const testCmd = process.env.EVOLUTION_TEST_CMD?.trim() || 'npm run test:unit';
    const skipCi = truthy(process.env.EVOLUTION_SKIP_NPM_CI);
    /** dist/ 被 gitignore，与 `npm test`（先 build）不同，单独跑 test:unit 前必须编译 TS */
    const skipBuild = truthy(process.env.EVOLUTION_SKIP_BUILD);
    const buildCmd =
      process.env.EVOLUTION_BUILD_CMD !== undefined
        ? process.env.EVOLUTION_BUILD_CMD.trim()
        : 'npx tsc -b packages/core packages/capability-gateway';

    trace(`inbox: ${inboxPath}`);
    trace(
      `解析: ${newlyListedItems.length > 0 ? '仅执行“今日新条目”分段' : 'inbox 无“今日新条目”分段，回退全量解析'}；` +
      `待处理候选 ${parsedTotal} 条，执行 ${items.length} 条（已处理 ${skippedCount} 条${rawMax && Number(rawMax) > 0 ? `，EVOLUTION_MAX_ITEMS 安全帽=${rawMax}` : ''}）`
    );
    trace(`策略: 目标分支=${targetBranch}, 测试=${testCmd}, npm ci=${skipCi ? '跳过' : '执行'}, 构建=${skipBuild || !buildCmd ? '跳过' : buildCmd}, 自动合并=${autoMerge ? '是' : '否'}`);
    trace(
      '说明：每条会先抓取来源 URL 的正文摘录（供对照）；验证阶段在本仓库独立 worktree 跑白名单测试，不克隆外链仓库。'
    );
    const agentCmdPreview = process.env.EVOLUTION_AGENT_CMD?.trim() || '';
    const planCmdPreview = process.env.EVOLUTION_PLAN_CMD?.trim() || '';
    const reviewCmdPreview = process.env.EVOLUTION_REVIEW_CMD?.trim() || '';
    const refineCmdPreview = process.env.EVOLUTION_REFINE_CMD?.trim() || '';
    trace(
      agentCmdPreview
        ? `实现钩子: ${JSON.stringify(agentCmdPreview.slice(0, 120))}${agentCmdPreview.length > 120 ? '…' : ''}（EVOLUTION_AGENT_CMD）`
        : '实现钩子: 未设置（EVOLUTION_AGENT_CMD 为空则构建后直接跑测试）'
    );
    trace(
      planCmdPreview
        ? `规划钩子: ${JSON.stringify(planCmdPreview.slice(0, 120))}（EVOLUTION_PLAN_CMD）`
        : '规划钩子: 未设置（可选 Codex 写 .evolution/dev-plan.md）'
    );
    trace(
      reviewCmdPreview
        ? `审查钩子: ${JSON.stringify(reviewCmdPreview.slice(0, 120))}（EVOLUTION_REVIEW_CMD；通过后才会 rebase/合并）`
        : '审查钩子: 未设置（测试通过后直接进入 rebase）'
    );
    trace(
      refineCmdPreview
        ? `精炼钩子: ${JSON.stringify(refineCmdPreview.slice(0, 120))}（EVOLUTION_REFINE_CMD；未设则用 EVOLUTION_AGENT_CMD）`
        : '精炼钩子: 未单独设置（审查未通过时用 EVOLUTION_AGENT_CMD）'
    );
    const testAgentPreview = process.env.EVOLUTION_TEST_AGENT_CMD?.trim() || '';
    trace(
      testAgentPreview
        ? `测试补强钩子: ${JSON.stringify(testAgentPreview.slice(0, 120))}（构建后、正式测试前；EVOLUTION_TEST_AGENT_CMD）`
        : '测试补强钩子: 未设置（构建后直接跑 EVOLUTION_TEST_CMD）'
    );

    const conc = Math.min(
      MAX_EVOLUTION_CONCURRENCY,
      Math.max(1, Number(process.env.EVOLUTION_CONCURRENCY ?? MAX_EVOLUTION_CONCURRENCY) || MAX_EVOLUTION_CONCURRENCY)
    );
    const withMergeLock = createMergeMutex();
    trace(
      autoMerge
        ? `并发: ${conc}（EVOLUTION_CONCURRENCY，上限 ${MAX_EVOLUTION_CONCURRENCY}）；合并主分支串行（互斥锁）`
        : `并发: ${conc}（EVOLUTION_CONCURRENCY，上限 ${MAX_EVOLUTION_CONCURRENCY}）`
    );

    // ── 多轮调度执行 ─────────────────────────────────────────────────────
    const currentRound = progress.roundsCompleted + 1;
    trace(`当前轮次: ${currentRound}/${roundsPerDay}`);

    const today = utcDateString(new Date());
    const todaySlot = utcDateTimeString(new Date()) + `-r${currentRound}`;
    const wtRoot = join(repoRoot, '.evolution-worktrees');
    await mkdir(wtRoot, { recursive: true });

    // 更新进度：开始本轮
    progress.roundsCompleted = currentRound;
    saveProgress(progress);

    const runOne = async ({ title, link }, i) => {
      const _tItemStart = Date.now();
      let _evtCapTags = [];
      try { _evtCapTags = tagCapabilities({ title, url: link, summary: '' }); } catch { /**/ }
      let _evtSource = '';
      try { _evtSource = new URL(link).hostname.replace(/^www\./, ''); } catch { /**/ }
  const _evtAgentCmd = process.env.EVOLUTION_AGENT_CMD?.trim() || '';
  let _orchRunId = '';
  const _evt = {
    runId,
    itemId: makeSlug(title, link),
    stage: 'skip',
    capabilityTags: _evtCapTags,
    source: _evtSource,
    agent: /cursor/i.test(_evtAgentCmd) ? 'cursor' : /claude/i.test(_evtAgentCmd) ? 'claude' : /codex/i.test(_evtAgentCmd) ? 'codex' : '',
    model: process.env.RAW_AGENT_MODEL_NAME?.trim() || '',
    status: 'skipped',
    durationMs: 0,
    costEstimate: 0,
    failureType: null,
    artifacts: [],
    nextAction: '',
    orchestrationRunId: '',
  };
      try {
      const slot = `${i + 1}/${items.length}`;
      const itemTrace = (msg) => trace(`[${slot}] ${msg}`);
      let branchHasCommittedChanges = false;

      const slug = makeSlug(title, link);
      const branch = `exp/evolution-${todaySlot}-${slug}`;
      const wtPath = join(wtRoot, `${todaySlot}-${slug}`);

      itemTrace(`━━ 开始 ━━`);
      itemTrace(`标题: ${title}`);
      itemTrace(`链接: ${link}`);

      // ── Orchestrator 集成（可选，EVOLUTION_USE_ORCHESTRATOR=1）──────────────
      if (truthy(process.env.EVOLUTION_USE_ORCHESTRATOR)) {
        try {
          const orchResult = await createOrchestrationRunForItem(
            { id: slug, title, url: link, summary: '' },
            {
              daemonUrl: process.env.EVOLUTION_DAEMON_URL,
              capabilityTags: _evtCapTags,
              agent: _evt.agent,
              model: _evt.model,
            }
          );
          _orchRunId = orchResult.runId;
          _evt.orchestrationRunId = _orchRunId;
          if (_orchRunId) {
            itemTrace(`orchestration run 已创建: ${_orchRunId}`);
            appendOrchestrationStep(_orchRunId, { stage: 'classify', status: 'completed' }, {
              daemonUrl: process.env.EVOLUTION_DAEMON_URL
            }).catch(() => {});
            appendOrchestrationEvent(
              _orchRunId,
              { kind: 'evolution_item_started', payload: { slug, title } },
              { daemonUrl: process.env.EVOLUTION_DAEMON_URL }
            ).catch(() => {});
          }
        } catch (e) {
          itemTrace(`orchestration run 创建失败（非致命）: ${e.message}`);
        }
      }

      const tFetch = Date.now();
      const fetched = await fetchSourceExcerpt(link);
      if (fetched.ok && fetched.excerpt) {
        itemTrace(`来源正文已抓取 ${fetched.excerpt.length} 字（${Date.now() - tFetch}ms）`);
      } else {
        itemTrace(`来源正文抓取失败或为空: ${fetched.error || 'empty'}（${Date.now() - tFetch}ms）`);
      }
      const sourceExcerpt = fetched.excerpt || '';
      const sourceFetchError = fetched.ok ? '' : fetched.error || 'fetch failed';

      itemTrace(`slug=${slug} → 分支 ${branch}，worktree ${wtPath}`);

      const tPrep = Date.now();
      await removeWorktree(wtPath, branch, itemTrace);
      itemTrace(`清理旧 worktree/分支 (${Date.now() - tPrep}ms)`);

      const tWt = Date.now();
      const add = await run('git', ['worktree', 'add', '-b', branch, wtPath, targetBranch], { cwd: repoRoot });
      itemTrace(`git worktree add → exit=${add.code} (${Date.now() - tWt}ms)`);
      if (add.code !== 0) {
        itemTrace('结果: 失败（worktree）→ 已写 doc/evolution/failure/');
        await writeFailureDoc({
          slug,
          title,
          link,
          branch,
          testCmd,
          errTail: add.out + add.err,
          analysis: 'git worktree add 失败（可能分支已存在或路径占用）。',
          sourceExcerpt,
          sourceFetchError
        });
        Object.assign(_evt, { stage: 'implement', status: 'failed', failureType: 'worktree_failed' });
        return;
      }

      await copyEnvToWorktree(wtPath, itemTrace);
      await copyGatewayConfigToWorktree(wtPath, itemTrace);

      let testOut = '';
      let testErr = '';
      let testCode = 1;

      if (!skipCi) {
        const tCi = Date.now();
        const ci = await sh('npm ci', wtPath);
        testOut += ci.out + ci.err;
        itemTrace(`npm ci → exit=${ci.code} (${Date.now() - tCi}ms)`);
        if (ci.code !== 0) {
          itemTrace('结果: 失败（npm ci）→ 已写 doc/evolution/failure/');
          await removeWorktree(wtPath, branch, itemTrace);
          await writeFailureDoc({
            slug,
            title,
            link,
            branch,
            testCmd: 'npm ci',
            errTail: testOut,
          analysis: 'npm ci 失败（依赖或网络）。可设置 EVOLUTION_SKIP_NPM_CI=1 跳过安装（需自行保证 worktree 可测）。',
          sourceExcerpt,
          sourceFetchError
        });
        Object.assign(_evt, { stage: 'implement', status: 'failed', failureType: 'npm_ci_failed' });
        return;
      }
      } else {
        itemTrace('npm ci 已跳过（EVOLUTION_SKIP_NPM_CI）');
      }

      let agentHookCmd = '';
      let agentHookOut = '';
      let gitDiffStat = '';

      const rawResearchCmd = process.env.EVOLUTION_RESEARCH_CMD?.trim() || '';
      const rawAgentCmd = process.env.EVOLUTION_AGENT_CMD?.trim() || '';
      const rawPlanCmd = process.env.EVOLUTION_PLAN_CMD?.trim() || '';
      const rawReviewCmd = process.env.EVOLUTION_REVIEW_CMD?.trim() || '';
      const rawTestAgentCmd = process.env.EVOLUTION_TEST_AGENT_CMD?.trim() || '';

      // 为研究 / 规划 / 实现 / 测试补强 / 审查 准备 .evolution/ 上下文文件（摘录 + 约束）
      let agentCtx = null;
      if (rawResearchCmd || rawAgentCmd || rawPlanCmd || rawReviewCmd || rawTestAgentCmd) {
        agentCtx = await prepareAgentContext(wtPath, {
          excerpt: sourceExcerpt,
          title,
          link,
          fetchError: sourceFetchError
        });
        itemTrace('已写入 .evolution/source-excerpt.txt 与 .evolution/constraints.txt');
      }

      // ── 研究阶段（可选）：评估文章是否有有价值的改进机会 ──────────────────
      if (rawResearchCmd) {
        const decisionFile = join(agentCtx.dir, 'research-decision.txt');
        const { run: researchRunCmd, note: researchCmdNote } = resolveAgentCmdForWorktree(wtPath, rawResearchCmd);
        if (researchCmdNote) itemTrace(researchCmdNote);
        const tResearch = Date.now();
        const researchRes = await sh(researchRunCmd, wtPath, {
          env: {
            ...envForAgentHook(wtPath, title, link, agentCtx.excerptFile, agentCtx.constraintsFile, sourceFetchError, {
              EVOLUTION_RESEARCH_DECISION_FILE: decisionFile
            })
          }
        });
        itemTrace(`研究钩子 → exit=${researchRes.code} (${Date.now() - tResearch}ms)`);

        // 从决策文件解析 PROCEED / SKIP 及跳过类型
        let decisionWord = 'PROCEED';
        let skipType = '';
        let decisionReason = '';
        if (existsSync(decisionFile)) {
          const raw = readFileSync(decisionFile, 'utf8').trim();
          const lines = raw.split('\n').filter(Boolean);
          decisionWord = (lines[0] || '').trim().split(/[\s:]/)[0].toUpperCase();

          // 第二行可能是跳过类型
          const possibleSkipType = (lines[1] || '').trim().toUpperCase();
          if (['SUPERSEDED', 'DUPLICATE', 'IRRELEVANT', 'OUTDATED', 'TOO_COMPLEX'].includes(possibleSkipType)) {
            skipType = possibleSkipType;
            decisionReason = lines.slice(2).join('\n').trim();
          } else {
            // 旧格式：第二行就是理由
            decisionReason = lines.slice(1).join('\n').trim();
          }
        } else if (researchRes.code !== 0) {
          itemTrace('研究脚本非零退出且无决策文件，默认继续执行');
          decisionReason = `研究脚本退出码=${researchRes.code}`;
        }

        if (decisionWord === 'SKIP') {
          const reason = decisionReason || '研究阶段判断无有价值的改进机会';
          const skipLabel = SKIP_TYPE_LABELS[skipType] || skipType || '无改进机会';
          itemTrace(`研究结论: 跳过 [${skipLabel}]（${reason.slice(0, 150)}）→ 已写 doc/evolution/${skipType === 'SUPERSEDED' || skipType === 'DUPLICATE' ? 'superseded' : 'no-op'}/`);
          await removeWorktree(wtPath, branch, itemTrace);
          itemTrace('worktree 已移除');
          await writeResearchDecisionDoc({
            slug,
            title,
            link,
            branch,
            decision: decisionWord,
            skipType,
            reason,
            sourceExcerpt,
            sourceFetchError,
            researchCmd: rawResearchCmd,
            researchOut: (researchRes.out + researchRes.err).slice(0, 4000)
          });
          Object.assign(_evt, { stage: 'research', status: 'skipped', failureType: skipType || null });
          return;
        }
        const proceedReason = decisionReason || 'agent 认为有改进机会';
        itemTrace(`研究结论: 继续研发（${proceedReason.slice(0, 200)}）`);
      }

      // ── 规划阶段（可选）：Codex 等写入 .evolution/dev-plan.md ───────────────
      if (rawPlanCmd && !truthy(process.env.EVOLUTION_SKIP_PLAN)) {
        if (!agentCtx) {
          agentCtx = await prepareAgentContext(wtPath, {
            excerpt: sourceExcerpt,
            title,
            link,
            fetchError: sourceFetchError
          });
          itemTrace('已为规划阶段补写 .evolution 摘录/约束');
        }
        const planFile = join(wtPath, '.evolution', 'dev-plan.md');
        await mkdir(join(wtPath, '.evolution'), { recursive: true });
        await writeFile(
          planFile,
          '# Development plan\n\n_(planning agent: replace with concrete steps)_\n',
          'utf8'
        );
        const planPrompt =
          `You are a technical lead producing a SHORT implementation plan for a TypeScript/Node monorepo.\n` +
          `Worktree: ${wtPath}\nTask title: ${title}\nSource URL: ${link}\n\n` +
          `Read context from EVOLUTION_SOURCE_EXCERPT_FILE and EVOLUTION_AGENT_CONSTRAINTS_FILE.\n\n` +
          `Write the plan as markdown to this exact path (overwrite):\n${planFile}\n` +
          `(environment variable EVOLUTION_PLAN_FILE should point to the same path).\n\n` +
          `Include: goal (brief); files/packages likely to touch; ordered steps; how to verify (tests/commands).\n` +
          `Rules: do NOT implement product code in this step — only edit/create the plan file under .evolution/.\n`;
        const { run: planRunCmd, note: planNote } = resolveAgentCmdForWorktree(wtPath, rawPlanCmd);
        if (planNote) itemTrace(planNote);
        const tPl = Date.now();
        const plRes = await sh(planRunCmd, wtPath, {
          env: {
            ...envForAgentHook(wtPath, title, link, agentCtx.excerptFile, agentCtx.constraintsFile, sourceFetchError, {
              EVOLUTION_PLAN_FILE: planFile,
              AI_FIX_PROMPT: clampAgentCliPrompt(planPrompt, 'EVOLUTION_PLAN_CMD')
            })
          }
        });
        itemTrace(`规划钩子 → exit=${plRes.code} (${Date.now() - tPl}ms)`);
        if (plRes.code !== 0) {
          itemTrace(`规划失败摘录:\n${tailForLog(plRes.out + plRes.err)}`);
          await removeWorktree(wtPath, branch, itemTrace);
          itemTrace('worktree 已移除');
          await writeFailureDoc({
            slug,
            title,
            link,
            branch,
            testCmd: rawPlanCmd,
            errTail: plRes.out + plRes.err,
            analysis:
              'EVOLUTION_PLAN_CMD 非零退出。可检查 CLI、权限，或设 EVOLUTION_SKIP_PLAN=1 跳过规划。',
            sourceExcerpt,
            sourceFetchError
          });
          Object.assign(_evt, { stage: 'implement', status: 'failed', failureType: 'plan_failed' });
          return;
        }
        const planMax = Math.max(4000, envPositiveInt('EVOLUTION_AGENT_PLAN_MAX_CHARS', 32_000));
        truncateAgentTextFile(planFile, planMax, '.evolution/dev-plan.md');
      } else if (rawPlanCmd && truthy(process.env.EVOLUTION_SKIP_PLAN)) {
        itemTrace('已跳过规划（EVOLUTION_SKIP_PLAN=1）');
      }

      // ── 实现阶段（EVOLUTION_AGENT_CMD）──────────────────────────────────────
      const planFileForAgent = join(wtPath, '.evolution', 'dev-plan.md');
      if (existsSync(planFileForAgent)) {
        const planMax0 = Math.max(4000, envPositiveInt('EVOLUTION_AGENT_PLAN_MAX_CHARS', 32_000));
        truncateAgentTextFile(planFileForAgent, planMax0, '.evolution/dev-plan.md');
      }
      if (rawAgentCmd) {
        agentHookCmd = rawAgentCmd;
        const { run: agentRunCmd, note: agentCmdNote } = resolveAgentCmdForWorktree(wtPath, rawAgentCmd);
        if (agentCmdNote) itemTrace(agentCmdNote);
        const tAgent = Date.now();
        const hookRes = await sh(agentRunCmd, wtPath, {
          env: envForAgentHook(wtPath, title, link, agentCtx.excerptFile, agentCtx.constraintsFile, sourceFetchError)
        });
        agentHookOut = hookRes.out + hookRes.err;
        testOut += agentHookOut;
        itemTrace(`Agent 钩子 → exit=${hookRes.code} (${Date.now() - tAgent}ms)`);
        if (hookRes.code !== 0) {
          itemTrace(`Agent 钩子失败摘录:\n${tailForLog(agentHookOut)}`);
          await removeWorktree(wtPath, branch, itemTrace, false);
          itemTrace('worktree 已移除');
          itemTrace('结果: 失败（Agent 钩子非零）→ 已写 doc/evolution/failure/');
          await writeFailureDoc({
            slug,
            title,
            link,
            branch,
            testCmd: rawAgentCmd,
            errTail: agentHookOut,
            analysis:
              'EVOLUTION_AGENT_CMD 非零退出；未执行构建与 EVOLUTION_TEST_CMD。若为 exit 127，多为 worktree 内找不到脚本：请将钩子脚本 git add/commit，或依赖 run-day 自动回退到主仓路径。',
            sourceExcerpt,
            sourceFetchError,
            agentHookSection: `## Agent 钩子（失败）\n\n命令：${JSON.stringify(rawAgentCmd)}\n\n`
          });
          Object.assign(_evt, { stage: 'implement', status: 'failed', failureType: 'agent_failed' });
          return;
        }
        // 检查 agent 主动跳过信号（一体化脚本中研究阶段写入）
        const agentSkipFile = join(wtPath, '.evolution', 'agent-skip-reason.txt');
        if (existsSync(agentSkipFile)) {
          const skipReason = readFileSync(agentSkipFile, 'utf8').trim() || '研究阶段判断无改进机会';
          itemTrace(`Agent 主动跳过: ${skipReason.slice(0, 200)} → 已写 doc/evolution/no-op/`);
          await removeWorktree(wtPath, branch, itemTrace);
          itemTrace('worktree 已移除');
          await writeNoOpDoc({
            slug,
            title,
            link,
            branch,
            noOpReason: skipReason,
            sourceExcerpt,
            sourceFetchError,
            researchCmd: rawAgentCmd,
            researchOut: agentHookOut.slice(0, 4000)
          });
          Object.assign(_evt, { stage: 'implement', status: 'skipped', failureType: null });
          return;
        }
        gitDiffStat = await captureGitWorktreeDiff(wtPath);
        if (gitDiffStat) {
          const clip = gitDiffStat.slice(0, 900);
          itemTrace(`worktree 变更:\n${clip}${gitDiffStat.length > 900 ? '…' : ''}`);
        }

        // Agent 产生的改动需要 commit 到分支，否则 merge 时是 no-op
        const stPor = await run('git', ['status', '--porcelain'], { cwd: wtPath });
        const hasChanges = stPor.out.trim().length > 0;
        if (hasChanges) {
          const cmr = await commitWorktreeChangesExcludingEvolution(
            wtPath,
            `evolution(agent): improvements inspired by ${title.slice(0, 60)}`,
            itemTrace
          );
          if (cmr.committed) {
            branchHasCommittedChanges = true;
          } else if (cmr.reason === 'commit_failed') {
            itemTrace('结果: 失败（Agent 改动提交失败）→ 已写 doc/evolution/failure/');
            await removeWorktree(wtPath, branch, itemTrace, false);
            await writeFailureDoc({
              slug,
              title,
              link,
              branch,
              testCmd: 'git commit',
              errTail: cmr.out + cmr.err,
              analysis: 'Agent 已产生源码改动，但提交实验分支失败；分支已保留供人工检查。',
              sourceExcerpt,
              sourceFetchError,
            agentHookSection: `## Agent 钩子\n\n命令：${JSON.stringify(rawAgentCmd)}\n\n`
          });
          Object.assign(_evt, { stage: 'implement', status: 'failed', failureType: 'commit_failed' });
          return;
        } else {
            itemTrace('agent 未产生可 commit 的代码改动（仅 .evolution/ 等排除项）');
          }
        } else {
          itemTrace('agent 未产生任何文件改动');
        }
        if (!branchHasCommittedChanges) {
          const noOpReason = 'Agent 未产生可提交的源码改动，提前结束，避免把基线测试失败误记到当前条目。';
          itemTrace(`结果: no-op（${noOpReason}）→ 已写 doc/evolution/no-op/`);
          await removeWorktree(wtPath, branch, itemTrace);
          itemTrace('worktree 已移除');
          await writeNoOpDoc({
            slug,
            title,
            link,
            branch,
            noOpReason,
            sourceExcerpt,
            sourceFetchError,
            researchCmd: rawAgentCmd,
            researchOut: agentHookOut.slice(0, 4000)
          });
          Object.assign(_evt, { stage: 'implement', status: 'skipped', failureType: null });
          return;
        }
      }

      if (!skipBuild && buildCmd) {
        const tBuild = Date.now();
        const bd = await sh(buildCmd, wtPath);
        testOut += bd.out + bd.err;
        itemTrace(`构建「${buildCmd}」→ exit=${bd.code} (${Date.now() - tBuild}ms)`);
        if (bd.code !== 0) {
          itemTrace('结果: 失败（TypeScript 构建）→ 已写 doc/evolution/failure/');
          await removeWorktree(wtPath, branch, itemTrace, !branchHasCommittedChanges);
          await writeFailureDoc({
            slug,
            title,
            link,
            branch,
            testCmd: buildCmd,
            errTail: testOut,
            analysis:
              '构建失败。仓库的 test:unit 依赖 packages/*/dist；默认会在 npm ci 后执行 `npx tsc -b packages/core packages/capability-gateway`。可设 EVOLUTION_BUILD_CMD 覆盖或 EVOLUTION_SKIP_BUILD=1（需 worktree 内已有 dist）。',
            sourceExcerpt,
            sourceFetchError
          });
          Object.assign(_evt, { stage: 'implement', status: 'failed', failureType: 'build_failed' });
          return;
        }
      } else if (skipBuild) {
        itemTrace('构建已跳过（EVOLUTION_SKIP_BUILD）');
      } else {
        itemTrace('构建已跳过（EVOLUTION_BUILD_CMD 为空）');
      }

      // ── 测试补强（可选）：构建之后、正式单测之前，专用 agent 补用例/修测试（推荐 Gemini）──
      if (rawTestAgentCmd && !truthy(process.env.EVOLUTION_SKIP_TEST_AGENT)) {
        if (!agentCtx) {
          agentCtx = await prepareAgentContext(wtPath, {
            excerpt: sourceExcerpt,
            title,
            link,
            fetchError: sourceFetchError
          });
          itemTrace('已为测试补强阶段补写 .evolution 摘录/约束');
        }
        const diffCap = Math.max(8000, Number(process.env.EVOLUTION_TEST_AGENT_DIFF_MAX_CHARS ?? 56_000) || 56_000);
        const diffText = await getWorktreeDiffVsBase(wtPath, targetBranch, diffCap);
        const planFile = join(wtPath, '.evolution', 'dev-plan.md');
        const planBit = existsSync(planFile) ? readFileSync(planFile, 'utf8').slice(0, 8000) : '';
        const testAgentPrompt =
          `You are a test-focused engineer in a TypeScript/Node monorepo worktree:\n${wtPath}\n\n` +
          `Task title: ${title}\nSource: ${link}\n\n` +
          `## Context excerpt (file: EVOLUTION_SOURCE_EXCERPT_FILE)\n` +
          `(read from disk if you need more)\n\n` +
          `## Plan (if any)\n\n${planBit || '_(no .evolution/dev-plan.md)_'}\n\n` +
          `## Current diff vs ${targetBranch} (truncated)\n\n\`\`\`diff\n${diffText}\n\`\`\`\n\n` +
          `Your job:\n` +
          `1. Run exactly: ${testCmd}\n` +
          `2. Improve **tests** where gaps exist: add cases for edge cases, regressions, or behaviors implied by the change/plan.\n` +
          `3. Prefer edits under **test/**, **__tests__/**, or *.test.* / *.spec.* files.\n` +
          `4. Change production code **only** if required to fix a clear bug exposed by tests — keep such edits minimal.\n` +
          `5. Do NOT commit — the pipeline will commit for you.\n` +
          `6. Re-run ${testCmd} until it passes before exiting.\n`;
        const { run: testAgentRunCmd, note: testAgentNote } = resolveAgentCmdForWorktree(wtPath, rawTestAgentCmd);
        if (testAgentNote) itemTrace(testAgentNote);
        const tTa = Date.now();
        const taRes = await sh(testAgentRunCmd, wtPath, {
          env: {
            ...envForAgentHook(wtPath, title, link, agentCtx.excerptFile, agentCtx.constraintsFile, sourceFetchError, {
              AI_FIX_PROMPT: clampAgentCliPrompt(testAgentPrompt, 'EVOLUTION_TEST_AGENT_CMD')
            })
          }
        });
        testOut += taRes.out + taRes.err;
        itemTrace(`测试补强钩子 → exit=${taRes.code} (${Date.now() - tTa}ms)`);
        if (taRes.code !== 0) {
          itemTrace(`测试补强失败摘录:\n${tailForLog(taRes.out + taRes.err)}`);
          await removeWorktree(wtPath, branch, itemTrace, false);
          await writeFailureDoc({
            slug,
            title,
            link,
            branch,
            testCmd: rawTestAgentCmd,
            errTail: taRes.out + taRes.err,
            analysis:
              'EVOLUTION_TEST_AGENT_CMD 非零退出。可检查 Gemini/Codex/Claude CLI，或设 EVOLUTION_SKIP_TEST_AGENT=1 跳过。',
            sourceExcerpt,
            sourceFetchError
          });
          Object.assign(_evt, { stage: 'test', status: 'failed', failureType: 'test_agent_failed' });
          return;
        }
        const taCommit = await commitWorktreeChangesExcludingEvolution(
          wtPath,
          `evolution(test-agent): strengthen tests — ${title.slice(0, 50)}`,
          itemTrace
        );
        if (taCommit.committed) {
          branchHasCommittedChanges = true;
        } else if (taCommit.reason === 'commit_failed') {
          itemTrace('结果: 失败（测试补强改动提交失败）→ 已写 doc/evolution/failure/');
          await removeWorktree(wtPath, branch, itemTrace, false);
          await writeFailureDoc({
            slug,
            title,
            link,
            branch,
            testCmd: 'git commit',
            errTail: taCommit.out + taCommit.err,
            analysis: '测试补强 agent 已产生改动，但提交实验分支失败；分支已保留供人工检查。',
            sourceExcerpt,
            sourceFetchError
          });
          Object.assign(_evt, { stage: 'test', status: 'failed', failureType: 'test_agent_commit_failed' });
          return;
        }
        if (taCommit.committed && !skipBuild && buildCmd) {
          const tRb2 = Date.now();
          const bd2 = await sh(buildCmd, wtPath);
          testOut += bd2.out + bd2.err;
          itemTrace(`测试补强后重新构建「${buildCmd}」→ exit=${bd2.code} (${Date.now() - tRb2}ms)`);
          if (bd2.code !== 0) {
            itemTrace('结果: 失败（测试补强后构建失败）→ 已写 doc/evolution/failure/');
            await removeWorktree(wtPath, branch, itemTrace, false);
            await writeFailureDoc({
              slug,
              title,
              link,
              branch,
              testCmd: buildCmd,
              errTail: testOut,
          analysis: '测试补强 agent 提交改动后重新编译失败。',
            sourceExcerpt,
            sourceFetchError
          });
          Object.assign(_evt, { stage: 'test', status: 'failed', failureType: 'test_agent_build_failed' });
          return;
          }
        }
      } else if (rawTestAgentCmd && truthy(process.env.EVOLUTION_SKIP_TEST_AGENT)) {
        itemTrace('已跳过测试补强（EVOLUTION_SKIP_TEST_AGENT=1）');
      }

      const tTest = Date.now();
      const runTest = await sh(testCmd, wtPath, { env: enrichEnvForRunDayTests() });
      testOut += runTest.out;
      testErr += runTest.err;
      testCode = runTest.code;
      itemTrace(`测试命令「${testCmd}」→ exit=${testCode} (${Date.now() - tTest}ms)`);
      if (testCode !== 0) {
        itemTrace(`测试失败摘录:\n${tailForLog(testErr || testOut)}`);
      }

      // 测试通过后：可选 Codex 审查 + Claude/Codex 精炼循环，直至 APPROVE
      if (testCode === 0 && rawReviewCmd) {
        if (!agentCtx) {
          agentCtx = await prepareAgentContext(wtPath, {
            excerpt: sourceExcerpt,
            title,
            link,
            fetchError: sourceFetchError
          });
          itemTrace('已为审查阶段补写 .evolution 摘录/约束');
        }
        const rr = await runReviewRefineLoop({
          wtPath,
          targetBranch,
          title,
          link,
          excerptFile: agentCtx.excerptFile,
          constraintsFile: agentCtx.constraintsFile,
          testCmd,
          buildCmd,
          skipBuild,
          reviewCmd: rawReviewCmd,
          itemTrace
        });
        testOut += rr.extraOut || '';
        testErr += rr.extraErr || '';
        if (rr.hadCommits) branchHasCommittedChanges = true;
        if (!rr.ok) {
          itemTrace('结果: 失败（审查/精炼阶段）→ 已写 doc/evolution/failure/');
          await removeWorktree(wtPath, branch, itemTrace, !(branchHasCommittedChanges || rr.hadCommits));
          await writeFailureDoc({
            slug,
            title,
            link,
            branch,
            testCmd: `${testCmd}（含 evolution 审查/精炼）`,
          errTail: rr.errTail || testErr || testOut,
          analysis: rr.analysis || '审查或精炼流程失败。',
          sourceExcerpt,
          sourceFetchError
        });
        Object.assign(_evt, { stage: 'review', status: 'failed', failureType: 'review_failed' });
        return;
        }
        itemTrace(`审查流程结束：APPROVE（${rr.rounds ?? 0} 轮）`);
      }

      // 测试通过后，在 worktree 内 rebase targetBranch；有冲突则用 Codex / EVOLUTION_* agent 多轮修复后再 continue，成功后才进入后续合并
      if (testCode === 0 && !truthy(process.env.EVOLUTION_SKIP_REBASE)) {
        const tRb = Date.now();
        const rbOk = await rebaseWorktreeOntoWithAgentFixes(wtPath, targetBranch, itemTrace);
        itemTrace(`rebase 阶段总耗时 ${Date.now() - tRb}ms`);
        if (!rbOk) {
          itemTrace('结果: 失败（rebase 未完成）→ 已写 doc/evolution/failure/');
          await removeWorktree(wtPath, branch, itemTrace, !branchHasCommittedChanges);
          await writeFailureDoc({
            slug,
            title,
            link,
            branch,
            testCmd: `git rebase ${targetBranch}（含冲突自动修复）`,
            errTail: testOut + testErr,
            analysis:
              `测试通过后未能在 worktree 内完成 rebase 到 ${targetBranch}（冲突未解决、agent 不可用，或 rebase --continue 失败）。已执行 rebase --abort。可配置 EVOLUTION_REBASE_CONFLICT_CMD（推荐 Codex：bash scripts/evolution-rebase-conflict-codex.sh）、或 EVOLUTION_AGENT_CMD、或安装 codex；设 EVOLUTION_SKIP_REBASE=1 可跳过整段 rebase（不推荐）。`,
            sourceExcerpt,
            sourceFetchError
          });
          Object.assign(_evt, { stage: 'implement', status: 'failed', failureType: 'rebase_failed' });
          return;
        }
      } else if (testCode === 0 && truthy(process.env.EVOLUTION_SKIP_REBASE)) {
        itemTrace('已跳过 rebase（EVOLUTION_SKIP_REBASE=1）');
      }

      // 在 worktree 移除前分类变更（功能源码 vs 测试/文档）
      const changeClassification = await classifyBranchChanges(wtPath, targetBranch);
      itemTrace(
        `变更分类: 功能源码=${changeClassification.featurePaths.length} 个, 测试/文档=${changeClassification.nonFeaturePaths.length} 个` +
          (changeClassification.featurePaths.length > 0
            ? ` (${changeClassification.featurePaths.slice(0, 3).join(', ')}${changeClassification.featurePaths.length > 3 ? '…' : ''})`
            : '')
      );

      await removeWorktree(wtPath, branch, itemTrace, !branchHasCommittedChanges);
      itemTrace('worktree 已移除');

      if (testCode !== 0) {
        itemTrace('结果: 失败（测试非零）→ 已写 doc/evolution/failure/');
        await writeFailureDoc({
          slug,
          title,
          link,
          branch,
          testCmd,
          errTail: testErr || testOut,
          analysis:
            '测试命令非零退出（本仓库快照）。外链项目不会自动克隆；失败原因见上方测试摘录与 failure 文档中的完整输出。',
          sourceExcerpt,
          sourceFetchError
        });
        Object.assign(_evt, { stage: 'test', status: 'failed', failureType: 'test_failed' });
        return;
      }

      // 测试通过，但若无实际功能源码改动（仅补测试/文档等），跳过自动合并
      if (!changeClassification.hasFeatureChanges) {
        const skipReason =
          changeClassification.allPaths.length === 0
            ? '分支无任何提交改动（agent 未修改文件或仅修改了 .evolution/ 等排除项）'
            : `改动文件共 ${changeClassification.allPaths.length} 个，均为测试文件或文档，不含 packages/apps 下的功能源码`;
        itemTrace(`结果: 跳过合并（${skipReason}）→ 已写 doc/evolution/skip/`);
        await writeSkipDoc({
          slug,
          title,
          link,
          branch,
          testCmd,
          skipReason,
          featurePaths: changeClassification.featurePaths,
          nonFeaturePaths: changeClassification.nonFeaturePaths,
          sourceExcerpt,
          sourceFetchError,
          agentHookCmd,
          gitDiffStat
        });
        Object.assign(_evt, { stage: 'test', status: 'skipped', failureType: null });
        // 保留分支供手动审查
        console.log(`evolution-run-day: branch ${branch} kept (skip: no feature changes)`);
        return;
      }
      let merged = false;
      let mergeCommit = '';

      // ── 合并门禁（EVOLUTION_MERGE_RISK_CHECK / EVOLUTION_HARNESS_GATE）────────
      if (autoMerge && (truthy(process.env.EVOLUTION_MERGE_RISK_CHECK) || truthy(process.env.EVOLUTION_HARNESS_GATE))) {
        const gate = await checkMergeGate({
          capabilityTags: _evtCapTags,
          repoRoot,
        });
        if (!gate.allowed) {
          itemTrace(`合并门禁拦截: ${gate.reason} (action=${gate.action})`);
          if (gate.action === 'pr' || gate.action === 'backlog') {
            await writeBacklogEntry(
              {
                itemId: slug,
                title,
                url: link,
                riskLevel: gate.riskLevel || 'high',
                capabilityTags: _evtCapTags,
              },
              gate.reason,
              { repoRoot }
            ).catch((e) => itemTrace(`写 backlog 失败: ${e.message}`));
          }
          Object.assign(_evt, {
            stage: 'merge',
            status: 'skipped',
            failureType: gate.failureType || 'risk_blocked',
          });
          return;
        }
      }

      if (autoMerge) {
        const mergeResult = await withMergeLock(async () => {
          const tMerge = Date.now();

          // 注意：主分支脏检测已在启动时完成，此处不再重复检查
          const co = await run('git', ['checkout', targetBranch], { cwd: repoRoot });
          itemTrace(`git checkout ${targetBranch} → exit=${co.code}`);
          if (co.code !== 0) {
            itemTrace('结果: 失败（无法检出主分支以合并）');
            await writeFailureDoc({
              slug,
              title,
              link,
              branch,
              testCmd: `git checkout ${targetBranch}`,
              errTail: co.out + co.err,
              analysis: `测试通过但无法检出 ${targetBranch} 以合并。`,
              sourceExcerpt,
              sourceFetchError
            });
            return { ok: false };
          }
          const branchRef = await run('git', ['show-ref', '--verify', '--', `refs/heads/${branch}`], { cwd: repoRoot });
          if (branchRef.code !== 0) {
            itemTrace(`结果: 失败（merge 前实验分支不存在）`);
            await writeFailureDoc({
              slug,
              title,
              link,
              branch,
              testCmd: `git show-ref --verify refs/heads/${branch}`,
              errTail: branchRef.out + branchRef.err,
              analysis: 'merge 前实验分支已不存在；通常意味着 earlier cleanup 过早删除了分支或被并发任务复用清理。',
              sourceExcerpt,
              sourceFetchError
            });
            return { ok: false };
          }
          const mg = await run('git', ['merge', '--no-ff', '-m', `evolution: merge ${branch}`, branch], { cwd: repoRoot });
          itemTrace(`git merge ${branch} → exit=${mg.code} (${Date.now() - tMerge}ms)`);
          if (mg.code !== 0) {
            // 尝试用 agent 解决冲突
            const conflictFiles = await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repoRoot });
            const hasConflicts = conflictFiles.out.trim().length > 0;
            if (hasConflicts) {
              itemTrace(`merge 冲突文件: ${conflictFiles.out.trim().slice(0, 300)}`);
              const resolved = await resolveConflictsWithAgent(mg.out + mg.err + '\n' + conflictFiles.out, itemTrace);
              if (resolved) {
                const cm = await run(
                  'git',
                  ['commit', '-m', `evolution: merge ${branch} (conflicts resolved by agent)`],
                  { cwd: repoRoot }
                );
                itemTrace(`冲突解决后 commit → exit=${cm.code}`);
                if (cm.code === 0) {
                  const rev = await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
                  const mc = rev.out.trim().slice(0, 40);
                  itemTrace(`已合并（冲突由 agent 解决），merge commit: ${mc}`);
                  await run('git', ['branch', '-d', branch], { cwd: repoRoot }).catch(() => {});
                  return { ok: true, merged: true, mergeCommit: mc };
                }
                await run('git', ['merge', '--abort'], { cwd: repoRoot }).catch(() => {});
                itemTrace('结果: 失败（冲突解决后 commit 失败）');
                await writeFailureDoc({ slug, title, link, branch, testCmd: `git merge ${branch}`, errTail: cm.out + cm.err, analysis: 'agent 解决冲突后 commit 失败。', sourceExcerpt, sourceFetchError });
                return { ok: false };
              }
              await run('git', ['merge', '--abort'], { cwd: repoRoot }).catch(() => {});
              itemTrace('结果: 失败（agent 无法解决冲突）');
              await writeFailureDoc({ slug, title, link, branch, testCmd: `git merge ${branch}`, errTail: mg.out + mg.err + '\n' + conflictFiles.out, analysis: 'merge 冲突且 agent 无法解决；实验分支仍保留，请手动处理。', sourceExcerpt, sourceFetchError });
              return { ok: false };
            }
            await run('git', ['merge', '--abort'], { cwd: repoRoot }).catch(() => {});
            itemTrace('结果: 失败（合并失败，非冲突原因）');
            await writeFailureDoc({ slug, title, link, branch, testCmd: `git merge ${branch}`, errTail: mg.out + mg.err, analysis: 'git merge 非零退出但无冲突标记，可能是 fast-forward 失败或其他原因。', sourceExcerpt, sourceFetchError });
            return { ok: false };
          }
          const rev = await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
          const mc = rev.out.trim().slice(0, 40);
          itemTrace(`已合并，merge commit: ${mc}`);
          await run('git', ['branch', '-d', branch], { cwd: repoRoot }).catch(() => {});
          return { ok: true, merged: true, mergeCommit: mc };
        });
        if (!mergeResult.ok) {
          Object.assign(_evt, { stage: 'merge', status: 'failed', failureType: 'merge_failed' });
          return;
        }
        merged = mergeResult.merged;
        mergeCommit = mergeResult.mergeCommit;
      } else {
        itemTrace(`未自动合并：分支 ${branch} 保留，可手动 git merge`);
        console.log(`evolution-run-day: branch ${branch} kept for manual merge`);
      }

      itemTrace('结果: 成功 → 已写 doc/evolution/success/');
      Object.assign(_evt, { stage: 'merge', status: 'completed', failureType: null });
      await writeSuccessDoc({
        slug,
        title,
        link,
        branch,
        testCmd,
        outTail: testOut,
        merged,
        mergeCommit,
        sourceExcerpt,
        sourceFetchError,
        agentHookCmd,
        agentHookOut,
        gitDiffStat,
        changeClassification
      });

      // 更新进度：仅 success/ 写入时计数
      progress.totalSuccessItems += 1;
    } finally {
      _evt.durationMs = Date.now() - _tItemStart;
      try { appendRunEvent(_evt); } catch { /**/ }
      // ── Orchestrator 状态更新（EVOLUTION_USE_ORCHESTRATOR=1）─────────────────
      if (truthy(process.env.EVOLUTION_USE_ORCHESTRATOR) && _orchRunId) {
        const orchStatus = _evt.status === 'completed' ? 'completed' : 'failed';
        appendOrchestrationEvent(
          _orchRunId,
          {
            kind: 'evolution_item_finished',
            payload: { status: _evt.status, stage: _evt.stage, failureType: _evt.failureType, durationMs: _evt.durationMs }
          },
          { daemonUrl: process.env.EVOLUTION_DAEMON_URL }
        ).catch(() => {});
        updateOrchestrationRunStatus(_orchRunId, orchStatus, {
          daemonUrl: process.env.EVOLUTION_DAEMON_URL,
        }).catch(() => {});
      }
      progress.totalItemsFinished += 1;
    }
    };

    await runPool(items, conc, runOne);

    trace('本轮条目处理完毕');
    trace('可读摘要 → doc/evolution/runs/latest-run-day.md');

    // 保存进度
    saveProgress(progress);
    trace(
      `进度已保存: 第 ${currentRound}/${roundsPerDay} 轮完成，本轮 inbox ${items.length} 条已跑完；本日累计完成 ${progress.totalItemsFinished} 条（含 success/failure/skip/no-op），其中 success ${progress.totalSuccessItems} 条`
    );

    // 多轮调度：如果还有剩余轮次，等待间隔后继续
    if (currentRound < roundsPerDay && roundIntervalMs > 0) {
      trace(`等待 ${roundIntervalMs / 1000} 秒后开始下一轮…`);
      await new Promise((resolve) => setTimeout(resolve, roundIntervalMs));
    }

    await deployShowcase({ trace, manual: false });
  } finally {
    try {
      await writeRunDayLog(logLines);
    } catch (e) {
      console.error('evolution-run-day: 写入 latest-run-day.md 失败', e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
