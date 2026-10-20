/**
 * 构建 evolution 展示站并同步到本地 GitHub Pages 仓库；可选 commit + push。
 *
 * 环境变量：
 *   EVOLUTION_SHOWCASE_AUTO_DEPLOY=1  — run-day 自动路径下需开启；手动 CLI 可传 manual:true 跳过此项
 *   EVOLUTION_SHOWCASE_DEPLOY_DIR     — Pages 仓库根目录（须已 git clone 且含 .git）
 *   EVOLUTION_SHOWCASE_GIT_PUSH=1     — 复制后 git add/commit/push（需已配置 remote）
 *   EVOLUTION_SHOWCASE_PAGES_GIT_URL  — 可选，仅日志备忘（例如 https://github.com/magele758/magele758.github.io.git）
 *   EVOLUTION_SHOWCASE_GIT_REMOTE_BRANCH — 可选，同步目标分支（默认取 Pages 仓当前分支名）
 *   EVOLUTION_SHOWCASE_GIT_SYNC_MODE — reset（默认）| rebase。纯生成首页建议 reset：fetch + 中止未完成合并 + reset --hard origin/<分支>，再覆盖 dist，避免 rebase 冲突
 *   EVOLUTION_SHOWCASE_DEPLOY_ARTIFACTS — 逗号分隔，从 dist 拷入 Pages 根目录的白名单（默认 index.html,styles.css,app.js,data）
 *   EVOLUTION_SHOWCASE_POST_COPY_CMD — 可选，复制后在 DEPLOY_DIR 执行的 shell（如未来 Astro：`pnpm install --frozen-lockfile && pnpm run build`）
 */
import { cpSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, sh, truthy } from './process.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..', '..');

const DEFAULT_DEPLOY_ARTIFACTS = ['index.html', 'styles.css', 'app.js', 'data'];

function parseDeployArtifacts() {
  const raw = process.env.EVOLUTION_SHOWCASE_DEPLOY_ARTIFACTS?.trim();
  if (!raw) return [...DEFAULT_DEPLOY_ARTIFACTS];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {{ trace?: (msg: string) => void; manual?: boolean }} [options]
 * - manual: true 时忽略 EVOLUTION_SHOWCASE_AUTO_DEPLOY（供 pnpm run evolution:showcase-deploy）
 * @returns {Promise<{ ok: boolean; skipped?: string }>}
 */
export async function deployShowcase(options = {}) {
  const trace = options.trace ?? (() => {});
  const manual = options.manual === true;

  if (!manual && !truthy(process.env.EVOLUTION_SHOWCASE_AUTO_DEPLOY)) {
    return { ok: true, skipped: 'auto_deploy_off' };
  }

  const deployDir = process.env.EVOLUTION_SHOWCASE_DEPLOY_DIR?.trim();
  if (!deployDir) {
    trace('展示站发布：未设置 EVOLUTION_SHOWCASE_DEPLOY_DIR，跳过');
    return { ok: false, skipped: 'no_deploy_dir' };
  }
  if (!existsSync(deployDir)) {
    trace(`展示站发布：目录不存在 ${deployDir}，跳过`);
    return { ok: false, skipped: 'bad_dir' };
  }
  if (!existsSync(join(deployDir, '.git'))) {
    trace(`展示站发布：${deployDir} 不是 git 仓库，跳过`);
    return { ok: false, skipped: 'not_git' };
  }

  const pagesOrigin = process.env.EVOLUTION_SHOWCASE_PAGES_GIT_URL?.trim();
  if (pagesOrigin) trace(`展示站发布：Pages 源仓库 ${pagesOrigin}`);

  trace('展示站发布：执行 build-evolution-showcase…');
  const build = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'build-evolution-showcase.mjs')], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env
  });
  if (build.status !== 0) {
    trace(`展示站发布：构建失败 exit=${build.status ?? build.signal}，跳过同步`);
    return { ok: false, skipped: 'build_failed' };
  }

  const distDir = join(repoRoot, 'evolution-showcase', 'dist');
  if (!existsSync(distDir)) {
    trace('展示站发布：evolution-showcase/dist 不存在，跳过');
    return { ok: false, skipped: 'no_dist' };
  }

  if (truthy(process.env.EVOLUTION_SHOWCASE_GIT_PUSH)) {
    const br = await run(deployDir, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = (br.out || '').trim() || 'main';
    const remoteBranch = process.env.EVOLUTION_SHOWCASE_GIT_REMOTE_BRANCH?.trim() || branch;
    const syncMode = (process.env.EVOLUTION_SHOWCASE_GIT_SYNC_MODE || 'reset').trim().toLowerCase();

    if (syncMode === 'rebase') {
      trace(`展示站发布：git pull --rebase origin ${remoteBranch}`);
      const pull = await run(deployDir, 'git', ['pull', '--rebase', 'origin', remoteBranch]);
      if (pull.code !== 0) {
        trace(`展示站发布：git pull --rebase 失败 — ${(pull.err || pull.out).trim()}`);
        trace('展示站发布：可改 EVOLUTION_SHOWCASE_GIT_SYNC_MODE=reset 或手动在 Pages 仓解决冲突');
        return { ok: false, skipped: 'git_pull' };
      }
    } else {
      await run(deployDir, 'git', ['rebase', '--abort']);
      await run(deployDir, 'git', ['merge', '--abort']);
      trace(`展示站发布：git fetch origin && reset --hard origin/${remoteBranch}（生成站与远程对齐，再覆盖 dist）`);
      const fe = await run(deployDir, 'git', ['fetch', 'origin']);
      if (fe.code !== 0) {
        trace(`展示站发布：git fetch 失败 — ${(fe.err || fe.out).trim()}`);
        return { ok: false, skipped: 'git_fetch' };
      }
      const rh = await run(deployDir, 'git', ['reset', '--hard', `origin/${remoteBranch}`]);
      if (rh.code !== 0) {
        trace(`展示站发布：git reset --hard 失败 — ${(rh.err || rh.out).trim()}`);
        return { ok: false, skipped: 'git_reset' };
      }
    }
  }

  const artifacts = parseDeployArtifacts();
  trace(`展示站发布：按白名单复制 dist → ${deployDir}（${artifacts.join(', ')}）`);
  for (const name of artifacts) {
    const src = join(distDir, name);
    if (!existsSync(src)) {
      trace(`展示站发布：dist 缺少 ${name}，跳过`);
      return { ok: false, skipped: 'missing_artifact' };
    }
    cpSync(src, join(deployDir, name), { recursive: true, force: true });
  }

  const postCmd = process.env.EVOLUTION_SHOWCASE_POST_COPY_CMD?.trim();
  if (postCmd) {
    trace(`展示站发布：POST_COPY_CMD 执行中…`);
    const pr = await sh(repoRoot, postCmd, deployDir);
    if (pr.code !== 0) {
      trace(`展示站发布：POST_COPY_CMD 失败 — ${(pr.err || pr.out).trim()}`);
      return { ok: false, skipped: 'post_copy' };
    }
  }

  if (!truthy(process.env.EVOLUTION_SHOWCASE_GIT_PUSH)) {
    trace('展示站发布：已复制（未设 EVOLUTION_SHOWCASE_GIT_PUSH=1，不 git push）');
    return { ok: true };
  }

  const addArgs = ['add', '--', ...artifacts];
  let r = await run(deployDir, 'git', addArgs);
  if (r.code !== 0) {
    trace(`展示站发布：git add 失败 — ${(r.err || r.out).trim()}`);
    return { ok: false, skipped: 'git_add' };
  }

  r = await run(deployDir, 'git', ['diff', '--cached', '--quiet']);
  if (r.code === 0) {
    trace('展示站发布：Pages 仓库无变更，跳过 commit/push');
    return { ok: true };
  }

  const msg = `chore: sync evolution showcase ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
  r = await run(deployDir, 'git', ['commit', '-m', msg]);
  if (r.code !== 0) {
    trace(`展示站发布：git commit 失败 — ${(r.err || r.out).trim()}`);
    return { ok: false, skipped: 'git_commit' };
  }

  r = await run(deployDir, 'git', ['push']);
  if (r.code !== 0) {
    trace(`展示站发布：git push 失败 — ${(r.err || r.out).trim()}`);
    return { ok: false, skipped: 'git_push' };
  }

  trace('展示站发布：已 push 到 GitHub Pages 仓库');
  return { ok: true };
}
