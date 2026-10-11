#!/usr/bin/env node
/**
 * 统一 Evolution 管线入口。
 *
 * 用法：node scripts/evolution-cli.mjs [options]
 *   或：npm run evolution -- [options]
 *
 * 选项：
 *   --learn                  先执行 learn（拉 RSS → inbox）
 *   --learn-only             仅执行 learn，不跑 run-day
 *   --pipeline-build         learn 前先编译 capability-gateway（等价于旧 evolution:pipeline）
 *   --agent <cli>            实现 agent：cursor | claude | codex | full | multi（默认 claude）
 *   --model <name>           cursor agent 模型（默认 composer-2-fast）
 *   --review <cli>           review agent：cursor | codex | none（默认 none）
 *   --review-model <name>    review 模型（仅 cursor review，默认与 --model 相同）
 *   --concurrency <n>        并发 worktree 数（默认 3；上限默认 32，可用 EVOLUTION_CONCURRENCY_MAX 覆盖，硬顶 200）
 *   --items <n>              最多处理 inbox 条目数（不设 = 全部）
 *   --merge                  测试通过后自动合并到目标分支
 *   --target-branch <b>      合并目标分支（默认 main）
 *   --skip-rebase            跳过测试后 rebase（不推荐）
 *   --until-empty            反复执行 run-day，直到当前 inbox 规则下待处理条目为 0（配合 --learn 可跑完当次写入的条目；受 --items 每轮上限约束时会多轮接力）
 *   --research <m>          研究/评估阶段：cursor（cursor-agent）| generic（scripts/evolution-research.sh，按 PATH 选 claude/gemini/codex）| none（不跑研究）；省略时与旧版一致（仅当 --agent cursor 时默认 cursor 研究）
 *   --test-agent <m>        构建后、单测前的测试补强：gemini | none；省略时不改环境（沿用 .env）
 *   --preset <name>        注入 scripts/evolution-presets.json 中的一组参数；其后仍可追加参数，后者覆盖同名项
 *   --list-presets         列出可用 preset 并退出
 *   -h, --help               打印此帮助
 *
 * 示例：
 *   npm run evolution -- --learn --agent cursor --review codex
 *   npm run evolution -- --preset cursor-composer
 *   npm run evolution -- --preset cursor-composer --concurrency 5 --merge
 *   npm run evolution -- --learn-only
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { EVOLUTION_DISABLED_CODE, considerEvolutionSchedule } from '../packages/core/src/evolution/surface.ts';
import { EVOLUTION_CONCURRENCY_HARD_CAP, maxEvolutionConcurrencyFromEnv } from './evolution/agent-prompts.mjs';
import { listCursorModels } from './evolution/cursor-models.mjs';
import { getEvolutionInboxPendingCount } from './evolution/inbox-loader.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');
loadDotenv({ path: join(repoRoot, '.env') });

/** 与 `evolution-run-day.mjs` 一致：`--concurrency` 与 `EVOLUTION_CONCURRENCY` 共用此上限。 */
const EVOLUTION_CONCURRENCY_CLI_MAX = maxEvolutionConcurrencyFromEnv();

// ── arg parsing ──────────────────────────────────────────────────────────────

const HELP = `
Usage: npm run evolution -- [options]

  --learn                  先执行 learn（拉 RSS → inbox）
  --learn-only             仅执行 learn，不跑 run-day
  --pipeline-build         learn 前先编译 capability-gateway
  --agent <cli>            实现 agent: cursor | claude | codex | full | multi  (默认 claude)
  --model <name>           cursor agent 模型 (默认 composer-2-fast)
  --review <cli>           review agent: cursor | codex | none  (默认 none)
  --review-model <name>    review 模型，仅 cursor review 时 (默认同 --model)
  --concurrency <n>        并发数 (默认 3；未设 env 时上限 32，可用 EVOLUTION_CONCURRENCY_MAX 覆盖，硬顶 200)
  --items <n>              最多处理 inbox 条目数
  --merge                  自动合并到目标分支
  --target-branch <b>      合并目标分支 (默认 main)
  --skip-rebase            跳过 rebase 步骤
  --until-empty            循环 run-day 直到 inbox 待处理为 0
  --research <m>           评估/研究: cursor | generic | none
  --test-agent <m>         测试补强: gemini | none
  --preset <name>          从 scripts/evolution-presets.json 展开参数（可再跟参数覆盖）
  --list-presets           列出 preset 名称
  -h, --help               打印此帮助

Examples:
  npm run evolution -- --learn --agent cursor --review codex
  npm run evolution -- --preset cursor-composer
  npm run evolution -- --preset cursor-composer --merge --concurrency 5
  npm run evolution -- --learn-only
`.trim();

const VALID_AGENTS  = new Set(['cursor', 'claude', 'codex', 'full', 'multi']);
const VALID_REVIEWS = new Set(['cursor', 'codex', 'none']);
const VALID_RESEARCH  = new Set(['cursor', 'generic', 'none']);
const VALID_TEST_AGENT = new Set(['gemini', 'none']);

function loadPresetMap() {
  const p = join(__dir, 'evolution-presets.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`[evolution] presets 读取失败 (${p})，视为空: ${e instanceof Error ? e.message : e}`);
    return {};
  }
}

/**
 * Expand `--preset name` tokens from evolution-presets.json (flat string array).
 * Later argv tokens win when parseArgs assigns duplicate options.
 */
export function expandPresetArgv(rawArgv) {
  const node = rawArgv[0] ?? process.argv[0];
  const script = rawArgv[1] ?? '';
  const args = rawArgv.slice(2);
  const out = [];
  const presetsMap = loadPresetMap();

  if (args.includes('--list-presets')) {
    const keys = Object.keys(presetsMap).filter((k) => !k.startsWith('_'));
    console.log(keys.join('\n') || '(evolution-presets.json 暂无 preset)');
    process.exit(0);
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--preset') {
      const key = args[++i];
      if (!key) {
        console.error('error: --preset 需要一个名称'); process.exit(1);
      }
      const raw = presetsMap[key];
      if (raw === undefined || raw === null) {
        const avail = Object.keys(presetsMap).filter((k) => !k.startsWith('_'));
        console.error(`error: 未知 preset "${key}"，可用: ${avail.join(', ') || '(空)'}`);
        process.exit(1);
      }
      const tokens = Array.isArray(raw) ? raw : raw.args;
      if (!Array.isArray(tokens) || tokens.some((t) => typeof t !== 'string')) {
        console.error(`error: preset "${key}" 须为字符串数组或为 { args: string[] }`);
        process.exit(1);
      }
      out.push(...tokens);
      continue;
    }
    out.push(a);
  }
  return [node, script, ...out];
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    learn: false,
    learnOnly: false,
    pipelineBuild: false,
    agent: 'claude',
    model: 'composer-2-fast',
    review: 'none',
    reviewModel: null,
    concurrency: null,
    items: null,
    merge: false,
    targetBranch: null,
    skipRebase: false,
    untilEmpty: false,
    research: undefined,
    testAgent: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      if (i + 1 >= args.length) { console.error(`error: ${a} 需要一个值`); process.exit(1); }
      return args[++i];
    };
    switch (a) {
      case '--learn':          opts.learn = true; break;
      case '--learn-only':     opts.learnOnly = true; opts.learn = true; break;
      case '--pipeline-build': opts.pipelineBuild = true; break;
      case '--merge':          opts.merge = true; break;
      case '--skip-rebase':    opts.skipRebase = true; break;
      case '--until-empty':    opts.untilEmpty = true; break;
      case '--research': {
        const v = next();
        if (!VALID_RESEARCH.has(v)) { console.error(`error: --research 须为 ${[...VALID_RESEARCH].join('|')}`); process.exit(1); }
        opts.research = v;
        break;
      }
      case '--test-agent': {
        const v = next();
        if (!VALID_TEST_AGENT.has(v)) { console.error(`error: --test-agent 须为 ${[...VALID_TEST_AGENT].join('|')}`); process.exit(1); }
        opts.testAgent = v;
        break;
      }
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      case '--agent': {
        const v = next();
        if (!VALID_AGENTS.has(v)) { console.error(`error: --agent 须为 ${[...VALID_AGENTS].join('|')}`); process.exit(1); }
        opts.agent = v;
        break;
      }
      case '--model':         opts.model = next(); break;
      case '--review': {
        const v = next();
        if (!VALID_REVIEWS.has(v)) { console.error(`error: --review 须为 ${[...VALID_REVIEWS].join('|')}`); process.exit(1); }
        opts.review = v;
        break;
      }
      case '--review-model':   opts.reviewModel = next(); break;
      case '--concurrency': {
        const n = parseInt(next(), 10);
        if (isNaN(n) || n < 1 || n > EVOLUTION_CONCURRENCY_CLI_MAX) {
          console.error(`error: --concurrency 须为 1~${EVOLUTION_CONCURRENCY_CLI_MAX}（或调大 EVOLUTION_CONCURRENCY_MAX，硬顶 ${EVOLUTION_CONCURRENCY_HARD_CAP}）`);
          process.exit(1);
        }
        opts.concurrency = n;
        break;
      }
      case '--items': {
        const n = parseInt(next(), 10);
        if (isNaN(n) || n < 1) { console.error('error: --items 须为正整数'); process.exit(1); }
        opts.items = n;
        break;
      }
      case '--target-branch': opts.targetBranch = next(); break;
      default:
        console.error(`error: 未知参数 ${a}，运行 --help 查看帮助`);
        process.exit(1);
    }
  }
  return opts;
}

// ── env builder ──────────────────────────────────────────────────────────────

const SCRIPTS = join(repoRoot, 'scripts');

function buildEnv(opts) {
  const env = { ...process.env };

  // agent
  const agentScripts = {
    cursor: `bash ${SCRIPTS}/evolution-agent-cursor.sh`,
    claude: `bash ${SCRIPTS}/evolution-agent-claude.sh`,
    codex:  `bash ${SCRIPTS}/evolution-agent-codex.sh`,
    full:   `bash ${SCRIPTS}/evolution-agent-full.sh`,
    multi:  `bash ${SCRIPTS}/evolution-agent-multi.sh`,
  };
  env.EVOLUTION_AGENT_CMD = agentScripts[opts.agent];

  if (opts.agent === 'cursor') {
    env.EVOLUTION_SKIP_PLAN = '1';
  }

  const researchScripts = {
    cursor: `bash ${SCRIPTS}/evolution-research-cursor.sh`,
    generic: `bash ${SCRIPTS}/evolution-research.sh`
  };
  if (opts.research === 'none') {
    delete env.EVOLUTION_RESEARCH_CMD;
  } else if (opts.research === 'cursor') {
    env.EVOLUTION_RESEARCH_CMD = researchScripts.cursor;
  } else if (opts.research === 'generic') {
    env.EVOLUTION_RESEARCH_CMD = researchScripts.generic;
  } else if (opts.agent === 'cursor') {
    env.EVOLUTION_RESEARCH_CMD = researchScripts.cursor;
  }

  if (opts.testAgent === 'none') {
    delete env.EVOLUTION_TEST_AGENT_CMD;
  } else if (opts.testAgent === 'gemini') {
    env.EVOLUTION_TEST_AGENT_CMD = `bash ${SCRIPTS}/evolution-test-agent-gemini.sh`;
  }

  // model
  if (opts.agent === 'cursor' || opts.review === 'cursor') {
    env.EVOLUTION_CURSOR_AGENT_MODEL = opts.model;
    env.EVOLUTION_CURSOR_AGENT_REVIEW_MODEL = opts.reviewModel ?? opts.model;
  }

  // review
  if (opts.review === 'codex') {
    env.EVOLUTION_REVIEW_CMD  = `bash ${SCRIPTS}/evolution-codex-prompt.sh`;
    // refine 走实现 agent（review 不过则由同一 agent 精炼）
    env.EVOLUTION_REFINE_CMD  = agentScripts[opts.agent];
    env.EVOLUTION_REBASE_CONFLICT_CMD = `bash ${SCRIPTS}/evolution-rebase-conflict-codex.sh`;
  } else if (opts.review === 'cursor') {
    env.EVOLUTION_REVIEW_CMD  = `bash ${SCRIPTS}/evolution-agent-cursor.sh`;
    env.EVOLUTION_REFINE_CMD  = `bash ${SCRIPTS}/evolution-agent-cursor.sh`;
    env.EVOLUTION_REBASE_CONFLICT_CMD = `bash ${SCRIPTS}/evolution-agent-cursor.sh`;
  }
  // review === 'none': 不设，run-day 默认跳过 review

  // misc
  if (opts.concurrency) env.EVOLUTION_CONCURRENCY = String(opts.concurrency);
  if (opts.items)       env.EVOLUTION_MAX_ITEMS    = String(opts.items);
  if (opts.merge)       env.EVOLUTION_AUTO_MERGE   = '1';
  if (opts.targetBranch) env.EVOLUTION_TARGET_BRANCH = opts.targetBranch;
  if (opts.skipRebase)  env.EVOLUTION_SKIP_REBASE  = '1';

  return env;
}

// ── runner ───────────────────────────────────────────────────────────────────

function sh(cmd, env) {
  return new Promise((resolve, reject) => {
    console.log(`\n[evolution] ${cmd}`);
    const child = spawn('bash', ['-c', cmd], { cwd: repoRoot, env, stdio: 'inherit' });
    child.on('close', code => code === 0 ? resolve() : reject(Object.assign(new Error(`exit ${code}`), { code })));
  });
}

async function preflightCursorModels(opts) {
  const requested = [];
  if (opts.agent === 'cursor') requested.push(opts.model);
  if (opts.review === 'cursor') requested.push(opts.reviewModel ?? opts.model);
  if (opts.research === 'cursor') requested.push(opts.model);
  if (requested.length === 0) return;

  const list = await listCursorModels(repoRoot).catch((error) => ({
    code: 1,
    out: '',
    err: error instanceof Error ? error.message : String(error),
    models: []
  }));
  if (list.code !== 0) {
    throw new Error(`无法执行 Cursor 模型预检（agent --list-models）：${(list.err || list.out).trim() || `exit ${list.code}`}`);
  }
  const available = new Set(list.models);
  const missing = [...new Set(requested)].filter((model) => !available.has(model));
  if (missing.length > 0) {
    throw new Error(
      `Cursor 当前账号不可用模型: ${missing.join(', ')}。可先运行 \`agent --list-models\` 查看；当前可用示例: ${list.models.slice(0, 12).join(', ')}`
    );
  }
}

async function main() {
  const opts = parseArgs(expandPresetArgv(process.argv));
  const decision = considerEvolutionSchedule({ reason: 'cli' });
  if (!decision.started) {
    console.error(`${EVOLUTION_DISABLED_CODE}: Evolution is hidden and will not run.`);
    return;
  }
  const env  = buildEnv(opts);
  await preflightCursorModels(opts);

  // ── summary ─────────────────────────────────────────────────────────────
  const reviewLabel = opts.review === 'none' ? '(跳过)' : opts.review;
  const modelLabel  = (opts.agent === 'cursor' || opts.review === 'cursor' || opts.research === 'cursor')
    ? ` model=${opts.model}${opts.reviewModel && opts.reviewModel !== opts.model ? `/review=${opts.reviewModel}` : ''}`
    : '';
  const researchLabel =
    opts.research === 'none' ? 'none' : opts.research === 'cursor' ? 'cursor' : opts.research === 'generic' ? 'generic' : opts.agent === 'cursor' ? 'cursor(默认)' : '(.env/省略)';
  const testAgentLabel = opts.testAgent === 'none' ? 'none' : opts.testAgent === 'gemini' ? 'gemini' : '(沿用.env)';
  console.log(
    `[evolution] 配置: agent=${opts.agent}${modelLabel} review=${reviewLabel} research=${researchLabel} test-agent=${testAgentLabel} concurrency=${opts.concurrency ?? 3}${opts.merge ? ' auto-merge' : ''}${opts.untilEmpty ? ' until-empty' : ''}`
  );

  // ── 1. optional build ────────────────────────────────────────────────────
  if (opts.pipelineBuild) {
    const buildCmd = process.env.EVOLUTION_PIPELINE_BUILD_CMD ?? 'npx tsc -b packages/capability-gateway';
    await sh(buildCmd, env);
  }

  // ── 2. learn ─────────────────────────────────────────────────────────────
  if (opts.learn) {
    await sh('node scripts/evolution-learn.mjs', env);
    if (opts.learnOnly) {
      console.log('[evolution] --learn-only 完成，退出。');
      return;
    }
  }

  // ── 3. run-day ───────────────────────────────────────────────────────────
  if (opts.untilEmpty) {
    const maxRuns = Math.max(1, Number(process.env.EVOLUTION_UNTIL_EMPTY_MAX_RUNS ?? 500) || 500);
    const drainEnv = { ...env };
    const prevRounds = Number(drainEnv.EVOLUTION_ROUNDS_PER_DAY ?? 1) || 1;
    drainEnv.EVOLUTION_ROUNDS_PER_DAY = String(Math.max(prevRounds, 100_000));

    if (!opts.learn) {
      const first = getEvolutionInboxPendingCount(repoRoot);
      if (first.pending === 0) {
        console.log('[evolution] --until-empty：当前无待处理 inbox 条目，跳过 run-day。');
        return;
      }
    }

    let iter = 0;
    while (true) {
      iter += 1;
      if (iter > maxRuns) {
        throw new Error(
          `--until-empty 已超过 EVOLUTION_UNTIL_EMPTY_MAX_RUNS=${maxRuns} 次 run-day，仍可能有未处理条目，请检查日志后手工继续或调大该环境变量`
        );
      }
      const before = getEvolutionInboxPendingCount(repoRoot);
      console.log(`\n[evolution] --until-empty：第 ${iter} 次 run-day（待处理约 ${before.pending} 条）…`);
      await sh('node scripts/evolution-run-day.mjs', drainEnv);
      const after = getEvolutionInboxPendingCount(repoRoot);
      if (after.pending === 0) {
        console.log(`[evolution] --until-empty：待处理已清空，共执行 ${iter} 次 run-day。`);
        break;
      }
      console.log(`[evolution] --until-empty：本轮后仍剩 ${after.pending} 条，继续…`);
    }
  } else {
    await sh('node scripts/evolution-run-day.mjs', env);
  }
}

main().catch(err => {
  console.error('[evolution] 失败:', err.message);
  process.exit(err.code ?? 1);
});
