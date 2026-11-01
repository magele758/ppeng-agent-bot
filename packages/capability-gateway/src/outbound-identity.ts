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

/** Optional claimed inbox address (`localPart@productDomain`) for email from fallback. */
export interface OutboundIdentityOptions {
  /**
   * Claimed agent-inbox address. Used only when `ChannelSpec.from` is empty.
   * Explicit `channel.from` always wins. When neither is set, email identity
   * stays unresolved and does not invent a from (no URL-host fallback).
   */
  claimedFrom?: string;
}

/**
 * Resolve email outbound From with documented precedence:
 * 1. Explicit `ChannelSpec.from` (wins)
 * 2. Claimed inbox `localPart@productDomain` when from is empty
 * 3. Otherwise unresolved — do not invent an address
 */
export function resolveEmailOutboundFrom(
  channel: Pick<ChannelSpec, 'from'>,
  claimedFrom?: string
): { from?: string; resolved: boolean; source?: 'channel' | 'claimed' } {
  const explicit = channel.from?.trim();
  if (explicit) return { from: explicit, resolved: true, source: 'channel' };
  const claimed = claimedFrom?.trim();
  if (claimed) return { from: claimed, resolved: true, source: 'claimed' };
  return { resolved: false };
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

function describeChannel(
  channel: ChannelSpec,
  env: NodeJS.ProcessEnv,
  options?: OutboundIdentityOptions
): OutboundIdentity {
  const base = { channelId: channel.id, kind: channel.type, resolved: true };
  switch (channel.type) {
    case 'feishu_bot': {
      const app = feishuApp(env);
      return { ...base, resolved: app.ready, sender: app.sender, recipient: channel.url.trim() || undefined };
    }
    case 'slack':
    case 'telegram':
      return { ...base, sender: tokenSource(channel), recipient: chatTarget(channel) };
    case 'email': {
      const emailFrom = resolveEmailOutboundFrom(channel, options?.claimedFrom);
      return {
        ...base,
        resolved: emailFrom.resolved,
        sender: emailFrom.from,
        recipient: channel.target?.trim() || undefined
      };
    }
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
  env: NodeJS.ProcessEnv = process.env,
  options?: OutboundIdentityOptions
): OutboundIdentity {
  if (draft.receiveId && draft.receiveIdType) return describeDirectFeishu(draft, env);
  const channel = channels.find((item) => item.id === draft.channelId);
  if (!channel) return { channelId: draft.channelId, kind: 'unknown', resolved: false };
  return describeChannel(channel, env, options);
}

export function previewOutboundDraft(
  draft: OutboundDraft,
  channels: ChannelSpec[],
  env: NodeJS.ProcessEnv = process.env,
  options?: OutboundIdentityOptions
): OutboundDraftPreview {
  return { ...draft, identity: describeOutboundIdentity(draft, channels, env, options) };
}
