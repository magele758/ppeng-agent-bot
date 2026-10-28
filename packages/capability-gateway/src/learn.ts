import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RawAgentRuntime } from '@ppeng/agent-core';
import { fetchFeedItems } from './feed.js';
import { createUserDeliveryPort } from './user-delivery-port.js';
import type { ChannelSpec, LearnConfig } from './types.js';
import { readGatewayState, writeGatewayState, type GatewayPersistedState } from './state.js';

function portDraft(
  gatewayDir: string,
  input: {
    channelId: string;
    text: string;
    event?: string;
    receiveId?: string;
    receiveIdType?: import('./outbound-drafts.js').FeishuReceiveIdType;
  },
  channels: import('./types.js').ChannelSpec[] = []
) {
  return createUserDeliveryPort({ gatewayDir, channels }).draft(input);
}


const MAX_SEEN = 8000;
const MAX_ROLLING = 300;
const DEFAULT_MAX_PER_FEED = 12;

export interface LearnRunResult {
  ok: boolean;
  newCount: number;
  digestPath?: string;
  error?: string;
  pushedChannels: string[];
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Exported for `scripts/evolution-learn.mjs` inbox + digest parity. */
export function buildDigestMarkdown(
  dateUtc: string,
  newItems: { title: string; link: string }[],
  rolling: { title: string; link: string }[]
): string {
  const lines: string[] = [
    '---',
    'name: Agent Tech Digest',
    'description: Rolling digest of agent-related feeds (maintained by capability-gateway).',
    '---',
    '',
    `# Agent 技术摘要 ${dateUtc}`,
    '',
    '## 今日新收录',
    newItems.length
      ? newItems.map((i) => `- [${i.title}](${i.link})`).join('\n')
      : '_（今日 RSS 无新条目）_',
    '',
    '## 近期滚动窗口（技能点线索）',
    rolling.length
      ? rolling.map((i) => `- [${i.title}](${i.link})`).join('\n')
      : '_（暂无）_',
    ''
  ];
  return lines.join('\n');
}

export async function runLearnCycle(input: {
  repoRoot: string;
  gatewayStateDir: string;
  runtime: RawAgentRuntime;
  learn: LearnConfig;
  channels: ChannelSpec[];
}): Promise<LearnRunResult> {
  const maxPer = input.learn.maxItemsPerFeed ?? DEFAULT_MAX_PER_FEED;
  let state = await readGatewayState(input.gatewayStateDir);
  const seen = new Set(state.seenLinks);
  const newForDigest: { title: string; link: string }[] = [];

  try {
    for (const feedUrl of input.learn.feeds) {
      const items = await fetchFeedItems(feedUrl, maxPer);
      for (const it of items) {
        if (!it.link || seen.has(it.link)) {
          continue;
        }
        seen.add(it.link);
        newForDigest.push({ title: it.title, link: it.link });
        state.rollingItems.unshift({
          title: it.title,
          link: it.link,
          fetchedAt: new Date().toISOString()
        });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, newCount: 0, error: msg, pushedChannels: [] };
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

  const subdir = input.learn.skillsSubdir.replace(/^\/+|\/+$/g, '');
  const skillDir = join(input.repoRoot, subdir, 'agent-tech-digest');
  await mkdir(skillDir, { recursive: true });
  const digestPath = join(skillDir, 'SKILL.md');
  await writeFile(digestPath, md, 'utf8');

  await input.runtime.reloadWorkspaceSkills();

  await writeGatewayState(input.gatewayStateDir, state);

  const pushed: string[] = [];
  const text =
    `【Agent Gateway 每日学习】${today}\n` +
    `新收录 ${newForDigest.length} 条；滚动库共 ${state.rollingItems.length} 条。\n` +
    `技能已写入 ${subdir}/agent-tech-digest/SKILL.md，可用 load_skill(Agent Tech Digest) 加载。`;

  for (const ch of input.channels) {
    try {
      await portDraft(input.gatewayStateDir, {
        channelId: ch.id,
        text,
        event: 'gateway.daily_learn'
      });
    } catch {
      /* channel optional */
    }
  }

  return {
    ok: true,
    newCount: newForDigest.length,
    digestPath: digestPath,
    pushedChannels: pushed
  };
}

export function shouldRunDailyLearn(
  state: GatewayPersistedState,
  hourUtc: number,
  now: Date = new Date()
): boolean {
  const today = utcDateString(now);
  if (state.lastLearnRunDateUtc === today) {
    return false;
  }
  return now.getUTCHours() >= hourUtc;
}

export async function maybeRunScheduledLearn(input: {
  repoRoot: string;
  gatewayStateDir: string;
  runtime: RawAgentRuntime;
  learn?: LearnConfig;
  channels: ChannelSpec[];
  hourUtc: number;
}): Promise<LearnRunResult | null> {
  if (!input.learn?.feeds?.length) {
    return null;
  }
  const state = await readGatewayState(input.gatewayStateDir);
  if (!shouldRunDailyLearn(state, input.hourUtc)) {
    return null;
  }
  return runLearnCycle({
    repoRoot: input.repoRoot,
    gatewayStateDir: input.gatewayStateDir,
    runtime: input.runtime,
    learn: input.learn,
    channels: input.channels
  });
}
