import type { OutboundDraft } from './outbound-drafts.js';
import type { ChannelSpec, ChannelType } from './types.js';

export type OutboundIdentityKind = ChannelType | 'feishu_app' | 'unknown';

/**
 * Who a draft will go out as, derived from config only (no network, no secrets).
 * `sender` is a non-secret handle: masked app id, env var *name*, or URL host.
 * `resolved: false` means a send would fail today (missing channel or credentials).
 */
export interface OutboundIdentity {
  channelId: string;
  kind: OutboundIdentityKind;
  resolved: boolean;
  sender?: string;
  recipient?: string;
}

export interface OutboundDraftPreview extends OutboundDraft {
  identity: OutboundIdentity;
}

function maskId(id: string): string {
  return id.length <= 8 ? `${id.slice(0, 2)}…` : `${id.slice(0, 4)}…${id.slice(-2)}`;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** Env var name or `inline`. Never the token value. */
function tokenSource(channel: ChannelSpec): string | undefined {
  const named = channel.tokenEnv?.trim();
  if (named) return `env:${named}`;
  const auth = Object.entries(channel.headers ?? {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1]?.trim();
  if (!auth) return undefined;
  const ref = auth.match(/^(?:Bearer\s+)?(?:env:|\$)([A-Za-z_][A-Za-z0-9_]*)$/i);
  return ref?.[1] ? `env:${ref[1]}` : 'inline';
}

function feishuApp(env: NodeJS.ProcessEnv): { sender?: string; ready: boolean } {
  const appId = env.RAW_AGENT_FEISHU_APP_ID?.trim();
  const ready = Boolean(appId && env.RAW_AGENT_FEISHU_APP_SECRET?.trim());
  return { sender: appId ? maskId(appId) : undefined, ready };
}

function chatTarget(channel: ChannelSpec): string | undefined {
  const target = channel.target?.trim();
  if (target) return target;
  return isHttp(channel.url) ? undefined : channel.url.trim() || undefined;
}

function describeChannel(channel: ChannelSpec, env: NodeJS.ProcessEnv): OutboundIdentity {
  const base = { channelId: channel.id, kind: channel.type, resolved: true };
  switch (channel.type) {
    case 'feishu_bot': {
      const app = feishuApp(env);
      return { ...base, resolved: app.ready, sender: app.sender, recipient: channel.url.trim() || undefined };
    }
    case 'slack':
    case 'telegram':
      return { ...base, sender: tokenSource(channel), recipient: chatTarget(channel) };
    case 'email':
      return {
        ...base,
        sender: channel.from?.trim() || hostOf(channel.url),
        recipient: channel.target?.trim() || undefined
      };
    case 'webhook':
    case 'http_post':
    case 'wecom_group_bot':
      return { ...base, sender: hostOf(channel.url) };
    default: {
      const unreachable: never = channel.type;
      throw new Error(`unknown channel type ${String(unreachable)}`);
    }
  }
}

function describeDirectFeishu(draft: OutboundDraft, env: NodeJS.ProcessEnv): OutboundIdentity {
  const app = feishuApp(env);
  return {
    channelId: draft.channelId,
    kind: 'feishu_app',
    resolved: app.ready,
    sender: app.sender,
    recipient: `${draft.receiveIdType}:${draft.receiveId}`
  };
}

/** Mirrors the routing in `releaseOutboundDraft`: a Feishu recipient wins over the channel. */
export function describeOutboundIdentity(
  draft: OutboundDraft,
  channels: ChannelSpec[],
  env: NodeJS.ProcessEnv = process.env
): OutboundIdentity {
  if (draft.receiveId && draft.receiveIdType) return describeDirectFeishu(draft, env);
  const channel = channels.find((item) => item.id === draft.channelId);
  if (!channel) return { channelId: draft.channelId, kind: 'unknown', resolved: false };
  return describeChannel(channel, env);
}

export function previewOutboundDraft(
  draft: OutboundDraft,
  channels: ChannelSpec[],
  env: NodeJS.ProcessEnv = process.env
): OutboundDraftPreview {
  return { ...draft, identity: describeOutboundIdentity(draft, channels, env) };
}
