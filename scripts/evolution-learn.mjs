#!/usr/bin/env node
/**
 * 每日拉取 gateway.config 中的 RSS，更新 gateway 状态、写入 skills digest、并生成 doc/evolution/inbox/YYYY-MM-DD.md。
 * 不依赖 daemon；不调用 reloadWorkspaceSkills（需重启 daemon 或 gateway POST /learn/run）。
 *
 * 支持多种信息源：
 * - RSS feeds（gateway.config.json learn.feeds）
 * - 本地文件目录（EVOLUTION_LOCAL_SOURCES，git 不跟踪的私有资料）
 * - 历史归档目录（EVOLUTION_ARCHIVE_DIR，已爬取但未测试的资料）
 *
 * 用法：npm run evolution:learn
 * 环境：EVOLUTION_GATEWAY_CONFIG、RAW_AGENT_STATE_DIR（默认 .agent-state）
 *       EVOLUTION_LOCAL_SOURCES — 本地/Obsidian 子目录（逗号分隔；无 http 链接时每 .md 整篇为一条，link 为 file://）
 *       EVOLUTION_ARCHIVE_DIR    — 历史归档目录（已爬取但未测试）
 * learn.feeds 可与本地源二选一：至少配置 RSS，或设本地/归档且路径存在（纯 Obsidian 可不填 feeds）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { EVOLUTION_DISABLED_CODE, considerEvolutionSchedule } from '../packages/core/src/evolution/surface.ts';
import { parseLocalSourceFile, scanDirRecursive } from './evolution/local-source-parse.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');
loadDotenv({ path: join(repoRoot, '.env') });

// RSS 拉取走 packages/capability-gateway `fetchFeedItems`，内部已用 HTTPS_PROXY / RAW_AGENT_HTTPS_PROXY
// 等构建 ProxyAgent；此处不再 setGlobalDispatcher（显式 dispatcher 会覆盖全局，原逻辑实际不生效）。

const MAX_SEEN = 8000;
const MAX_ROLLING = 300;
const DEFAULT_MAX_PER_FEED = 12;

function utcDateString(d) {
  return d.toISOString().slice(0, 10);
}

async function loadGatewayJson() {
  // Use the unified resolver from packages/core (single source of truth for env aliases
  // and example-file fallback). Lazy import keeps this script runnable without
  // touching unrelated runtime modules at top-level.
  const { findGatewayConfigPath } = await import(
    pathToFileURL(join(repoRoot, 'packages/core/dist/gateway-config-channels.js')).href
  );
  const p = findGatewayConfigPath(repoRoot);
  if (!p) {
    throw new Error('evolution-learn: no gateway.config.json / gateway.config.example.json found');
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function resolvePathMaybeRepo(p) {
  const t = p?.trim();
  if (!t) return '';
  return isAbsolute(t) ? t : join(repoRoot, t);
}

function hasConfiguredLocalSourceDirs() {
  const localSourceDirs = (process.env.EVOLUTION_LOCAL_SOURCES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return localSourceDirs.some((d) => existsSync(resolvePathMaybeRepo(d)));
}

function hasConfiguredArchive() {
  const archiveDir = process.env.EVOLUTION_ARCHIVE_DIR?.trim();
  if (!archiveDir) return false;
  return existsSync(resolvePathMaybeRepo(archiveDir));
}

/**
 * 扫描本地信息源目录，收集所有条目。
 * 支持递归扫描子目录。
 */
function scanLocalSources(dirs) {
  const items = [];
  for (const dir of dirs) {
    const absDir = isAbsolute(dir) ? dir : join(repoRoot, dir);
    if (!existsSync(absDir)) {
      console.log(`evolution-learn: 本地源目录不存在，跳过: ${absDir}`);
      continue;
    }

    // 递归扫描所有子目录
    const files = scanDirRecursive(absDir);
    for (const filePath of files) {
      try {
        const fileItems = parseLocalSourceFile(filePath);
        // 计算相对路径用于日志
        const relPath = filePath.replace(absDir, dir).replace(/^\//, '');
        items.push(...fileItems);
        console.log(`evolution-learn: 本地源 ${relPath} → ${fileItems.length} 条`);
      } catch (e) {
        console.error(`evolution-learn: 解析本地源失败 ${filePath}: ${e.message}`);
      }
    }
  }
  return items;
}

/**
 * 扫描历史归档目录，找出已爬取但未测试的条目。
 * 归档文件格式：YYYY-MM-DD-*.md（类似 success/failure 格式）
 * 提取 source_url 和 source_title 字段。
 */
function scanArchiveDir(archiveDir) {
  if (!archiveDir) return [];

  const absDir = isAbsolute(archiveDir) ? archiveDir : join(repoRoot, archiveDir);
  if (!existsSync(absDir)) {
    console.log(`evolution-learn: 归档目录不存在，跳过: ${absDir}`);
    return [];
  }

  const items = [];
  const files = readdirSync(absDir).filter((f) => f.endsWith('.md'));

  for (const file of files) {
    const filePath = join(absDir, file);
    try {
      const content = readFileSync(filePath, 'utf8');

      // 提取 YAML frontmatter 中的 source_url 和 source_title
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];
        const urlMatch = frontmatter.match(/source_url:\s*"?([^"\n]+)"?/);
        const titleMatch = frontmatter.match(/source_title:\s*"?([^"\n]+)"?/);

        if (urlMatch && titleMatch) {
          const link = urlMatch[1].trim();
          const title = titleMatch[1].trim();
          // 检查状态，只提取已爬取但未测试的（status: pending 或 research_only）
          const statusMatch = frontmatter.match(/status:\s*(\w+)/);
          const status = statusMatch ? statusMatch[1] : 'unknown';

          if (status === 'pending' || status === 'research_only' || status === 'archived') {
            items.push({ title, link, source: 'archive', originalFile: file });
          }
        }
      }
    } catch (e) {
      console.error(`evolution-learn: 解析归档文件失败 ${filePath}: ${e.message}`);
    }
  }

  if (items.length > 0) {
    console.log(`evolution-learn: 归档目录 ${absDir} → ${items.length} 条待验证`);
  }
  return items;
}

async function main() {
  const decision = considerEvolutionSchedule({ reason: 'cli' });
  if (!decision.started) {
    console.error(`${EVOLUTION_DISABLED_CODE}: Evolution is hidden and will not run.`);
    return;
  }
  const { fetchFeedItems } = await import(pathToFileURL(join(repoRoot, 'packages/capability-gateway/dist/feed.js')).href);
  const { readGatewayState, writeGatewayState } = await import(
    pathToFileURL(join(repoRoot, 'packages/capability-gateway/dist/state.js')).href
  );
  const { buildDigestMarkdown } = await import(pathToFileURL(join(repoRoot, 'packages/capability-gateway/dist/learn.js')).href);

  const cfg = await loadGatewayJson();
  const learn = cfg.learn || {};
  const feeds = Array.isArray(learn.feeds) ? learn.feeds : [];
  if (!feeds.length && !hasConfiguredLocalSourceDirs() && !hasConfiguredArchive()) {
    console.error(
      'evolution-learn: set learn.feeds and/or set EVOLUTION_LOCAL_SOURCES / EVOLUTION_ARCHIVE_DIR to existing paths (pure local/Obsidian may omit feeds)'
    );
    process.exitCode = 1;
    return;
  }

  const stateDir = process.env.RAW_AGENT_STATE_DIR?.trim() || '.agent-state';
  const gatewayDir = join(repoRoot, stateDir, 'gateway');
  await mkdir(gatewayDir, { recursive: true });

  const maxPer = learn.maxItemsPerFeed ?? DEFAULT_MAX_PER_FEED;
  let state = await readGatewayState(gatewayDir);
  const seen = new Set(state.seenLinks);
  const newForDigest = [];
  let feedOk = 0;
  let feedFail = 0;

  // ── 1. RSS feeds ──────────────────────────────────────────────────────
  for (const feedUrl of feeds) {
    try {
      const items = await fetchFeedItems(feedUrl, maxPer);
      feedOk += 1;
      for (const it of items) {
        if (!it.link || seen.has(it.link)) continue;
        seen.add(it.link);
        newForDigest.push({ title: it.title, link: it.link, source: 'rss' });
        state.rollingItems.unshift({
          title: it.title,
          link: it.link,
          fetchedAt: new Date().toISOString()
        });
      }
    } catch (e) {
      feedFail += 1;
      let msg = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.name === 'AggregateError' && Array.isArray(e.errors) && e.errors.length) {
        msg = e.errors.map((x) => (x instanceof Error ? x.message : String(x))).join('; ');
      }
      const cause = e instanceof Error && 'cause' in e && e.cause ? ` (${String(e.cause)})` : '';
      console.error(`evolution-learn: feed skip — ${feedUrl}\n  → ${msg}${cause}`);
    }
  }

  if (feedFail > 0 && feeds.length > 0) {
    console.error(`evolution-learn: ${feedFail}/${feeds.length} feed(s) failed (TLS/HTTP/network); others still applied.`);
  }

  // ── 2. 本地信息源目录 ─────────────────────────────────────────────────
  const localSourceDirs = (process.env.EVOLUTION_LOCAL_SOURCES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (localSourceDirs.length > 0) {
    const localItems = scanLocalSources(localSourceDirs);
    for (const it of localItems) {
      if (!seen.has(it.link)) {
        seen.add(it.link);
        newForDigest.push({ ...it, source: 'local' });
        state.rollingItems.unshift({
          title: it.title,
          link: it.link,
          fetchedAt: new Date().toISOString(),
          source: 'local'
        });
      }
    }
  }

  // ── 3. 历史归档目录（已爬取但未测试）─────────────────────────────────
  const archiveDir = process.env.EVOLUTION_ARCHIVE_DIR?.trim();
  if (archiveDir) {
    const archiveItems = scanArchiveDir(archiveDir);
    for (const it of archiveItems) {
      if (!seen.has(it.link)) {
        seen.add(it.link);
        newForDigest.push({ ...it, source: 'archive' });
        state.rollingItems.unshift({
          title: it.title,
          link: it.link,
          fetchedAt: new Date().toISOString(),
          source: 'archive'
        });
      }
    }
  }

  state.rollingItems = state.rollingItems.slice(0, MAX_ROLLING);
  state.seenLinks = [...seen].slice(-MAX_SEEN);

  const today = utcDateString(new Date());
  const md = buildDigestMarkdown(
    today,
    newForDigest,
    state.rollingItems.slice(0, 80).map((r) => ({ title: r.title, link: r.link }))
  );
  state.lastDigestMarkdown = md;
  state.lastLearnRunDateUtc = today;

  const subdir = (learn.skillsSubdir || 'skills').replace(/^\/+|\/+$/g, '');
  const skillDir = join(repoRoot, subdir, 'agent-tech-digest');
  await mkdir(skillDir, { recursive: true });
  const digestPath = join(skillDir, 'SKILL.md');
  await writeFile(digestPath, md, 'utf8');

  await writeGatewayState(gatewayDir, state);

  const inboxDir = join(repoRoot, 'doc', 'evolution', 'inbox');
  await mkdir(inboxDir, { recursive: true });

  // 按来源分组统计
  const rssCount = newForDigest.filter((i) => i.source === 'rss').length;
  const localCount = newForDigest.filter((i) => i.source === 'local').length;
  const archiveCount = newForDigest.filter((i) => i.source === 'archive').length;

  const inboxLines = [
    `# Evolution inbox ${today}`,
    '',
    '## 今日新条目',
    ...(newForDigest.length
      ? newForDigest.map((i) => `- [${i.title}](${i.link})`)
      : ['_（无新链接，仍已刷新滚动摘要）_']),
    '',
    '## 近期滚动（参考）',
    ...state.rollingItems.slice(0, 20).map((r) => `- [${r.title}](${r.link})`),
    '',
    '---',
    `digest_written: ${digestPath}`,
    `new_count: ${newForDigest.length}`,
    `source_rss: ${rssCount}`,
    `source_local: ${localCount}`,
    `source_archive: ${archiveCount}`
  ];
  const inboxPath = join(inboxDir, `${today}.md`);
  await writeFile(inboxPath, inboxLines.join('\n'), 'utf8');

  console.log(`evolution-learn: inbox ${inboxPath}`);
  console.log(`evolution-learn: digest ${digestPath} (new ${newForDigest.length}: rss=${rssCount}, local=${localCount}, archive=${archiveCount})`);
  if (feedOk === 0 && feeds.length > 0) {
    console.error(
      'evolution-learn: all feeds failed — check proxy/VPN or remove unreachable URLs (e.g. huggingface.co) from gateway.config.json learn.feeds'
    );
    process.exitCode = 1;
  }
  console.log('evolution-learn: restart daemon or POST gateway /learn/run to reload skills in runtime');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});