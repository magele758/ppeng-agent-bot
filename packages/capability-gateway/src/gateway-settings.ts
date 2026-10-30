/**
 * IM gateway inbound security settings — persisted in daemon_control KV.
 * Lab UI / PATCH /api/gateway/settings is the control plane (no env switches);
 * values here override the matching fields of gateway.config.json providers.
 */

import { ValidationError } from '@ppeng/agent-core';

export const GATEWAY_SETTINGS_KEY = 'gateway_im_settings';

export interface GatewayFeishuSettings {
  verificationToken?: string;
  encryptKey?: string;
  /** open_id / user_id / union_id / chat_id; empty = no sender restriction. */
  allowedSenders: string[];
  /** Route IM chats into this Bot's canonical session. */
  botId?: string;
}

export interface GatewayWecomSettings {
  bridgeSecret?: string;
  allowedSenders: string[];
  botId?: string;
}

export interface GatewayWebhookSettings {
  allowedSenders: string[];
}

export interface GatewaySlackSettings {
  /** Slack Events signing secret. Empty = not configured (inbound fails closed). */
  signingSecret?: string;
  /** Slack user ids; empty = no sender restriction. */
  allowedSenders: string[];
  /** Route Slack chats into this Bot's canonical session. */
  botId?: string;
}

export interface GatewaySettings {
  feishu: GatewayFeishuSettings;
  wecom: GatewayWecomSettings;
  webhook: GatewayWebhookSettings;
  slack: GatewaySlackSettings;
  updatedAt: string;
}

export interface GatewaySettingsPatch {
  feishu?: {
    verificationToken?: string | null;
    encryptKey?: string | null;
    allowedSenders?: string[];
    botId?: string | null;
  };
  wecom?: {
    bridgeSecret?: string | null;
    allowedSenders?: string[];
    botId?: string | null;
  };
  webhook?: { allowedSenders?: string[] };
  slack?: {
    signingSecret?: string | null;
    allowedSenders?: string[];
    botId?: string | null;
  };
}

export interface GatewaySettingsStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl?(key: string, value: unknown): void;
}

export interface GatewaySettingsView {
  feishu: {
    verificationTokenSet: boolean;
    encryptKeySet: boolean;
    allowedSenders: string[];
    botId?: string;
  };
  wecom: { bridgeSecretSet: boolean; allowedSenders: string[]; botId?: string };
  webhook: { allowedSenders: string[] };
  slack: { signingSecretSet: boolean; allowedSenders: string[]; botId?: string };
  updatedAt: string;
}

export function defaultGatewaySettings(): GatewaySettings {
  return {
    feishu: { allowedSenders: [] },
    wecom: { allowedSenders: [] },
    webhook: { allowedSenders: [] },
    slack: { allowedSenders: [] },
    updatedAt: new Date(0).toISOString()
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function list(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
}

export function normalizeGatewaySettings(raw: unknown): GatewaySettings {
  const base = defaultGatewaySettings();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, Record<string, unknown> | undefined>;
  return {
    feishu: {
      verificationToken: str(r.feishu?.verificationToken),
      encryptKey: str(r.feishu?.encryptKey),
      allowedSenders: list(r.feishu?.allowedSenders),
      botId: str(r.feishu?.botId)
    },
    wecom: {
      bridgeSecret: str(r.wecom?.bridgeSecret),
      allowedSenders: list(r.wecom?.allowedSenders),
      botId: str(r.wecom?.botId)
    },
    webhook: { allowedSenders: list(r.webhook?.allowedSenders) },
    slack: {
      signingSecret: str(r.slack?.signingSecret),
      allowedSenders: list(r.slack?.allowedSenders),
      botId: str(r.slack?.botId)
    },
    updatedAt: typeof (raw as { updatedAt?: unknown }).updatedAt === 'string'
      ? (raw as { updatedAt: string }).updatedAt
      : base.updatedAt
  };
}

export function readGatewaySettings(store: GatewaySettingsStore | undefined): GatewaySettings {
  if (!store || typeof store.getDaemonControl !== 'function') return defaultGatewaySettings();
  return normalizeGatewaySettings(store.getDaemonControl(GATEWAY_SETTINGS_KEY));
}

function applyOptional(current: string | undefined, next: string | null | undefined): string | undefined {
  if (next === undefined) return current;
  if (next === null) return undefined;
  return str(next);
}

export function writeGatewaySettings(
  store: GatewaySettingsStore,
  patch: GatewaySettingsPatch
): GatewaySettings {
  if (typeof store.setDaemonControl !== 'function') {
    throw new Error('gateway settings store cannot persist');
  }
  const cur = readGatewaySettings(store);
  const next: GatewaySettings = {
    feishu: {
      verificationToken: applyOptional(cur.feishu.verificationToken, patch.feishu?.verificationToken),
      encryptKey: applyOptional(cur.feishu.encryptKey, patch.feishu?.encryptKey),
      allowedSenders: patch.feishu?.allowedSenders ? list(patch.feishu.allowedSenders) : cur.feishu.allowedSenders,
      botId: applyOptional(cur.feishu.botId, patch.feishu?.botId)
    },
    wecom: {
      bridgeSecret: applyOptional(cur.wecom.bridgeSecret, patch.wecom?.bridgeSecret),
      allowedSenders: patch.wecom?.allowedSenders ? list(patch.wecom.allowedSenders) : cur.wecom.allowedSenders,
      botId: applyOptional(cur.wecom.botId, patch.wecom?.botId)
    },
    webhook: {
      allowedSenders: patch.webhook?.allowedSenders ? list(patch.webhook.allowedSenders) : cur.webhook.allowedSenders
    },
    slack: {
      signingSecret: applyOptional(cur.slack.signingSecret, patch.slack?.signingSecret),
      allowedSenders: patch.slack?.allowedSenders ? list(patch.slack.allowedSenders) : cur.slack.allowedSenders,
      botId: applyOptional(cur.slack.botId, patch.slack?.botId)
    },
    updatedAt: new Date().toISOString()
  };
  store.setDaemonControl(GATEWAY_SETTINGS_KEY, next);
  return next;
}

/** Never echo secrets: report only whether they are configured. */
export function redactGatewaySettings(s: GatewaySettings): GatewaySettingsView {
  return {
    feishu: {
      verificationTokenSet: Boolean(s.feishu.verificationToken),
      encryptKeySet: Boolean(s.feishu.encryptKey),
      allowedSenders: s.feishu.allowedSenders,
      botId: s.feishu.botId
    },
    wecom: {
      bridgeSecretSet: Boolean(s.wecom.bridgeSecret),
      allowedSenders: s.wecom.allowedSenders,
      botId: s.wecom.botId
    },
    webhook: { allowedSenders: s.webhook.allowedSenders },
    slack: {
      signingSecretSet: Boolean(s.slack.signingSecret),
      allowedSenders: s.slack.allowedSenders,
      botId: s.slack.botId
    },
    updatedAt: s.updatedAt
  };
}

function expectObject(v: unknown, name: string): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new ValidationError(`${name} must be an object`);
  }
  return v as Record<string, unknown>;
}

function expectNullableString(o: Record<string, unknown>, key: string, name: string): string | null | undefined {
  if (!(key in o)) return undefined;
  const v = o[key];
  if (v === null) return null;
  if (typeof v !== 'string') throw new ValidationError(`${name}.${key} must be a string or null`);
  return v;
}

function expectStringList(o: Record<string, unknown>, key: string, name: string): string[] | undefined {
  if (!(key in o)) return undefined;
  const v = o[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ValidationError(`${name}.${key} must be an array of strings`);
  }
  return v as string[];
}

/** Validate an untrusted PATCH body into a typed patch (throws ValidationError → 400). */
export function parseGatewaySettingsPatch(body: unknown): GatewaySettingsPatch {
  const root = expectObject(body ?? {}, 'body') ?? {};
  const patch: GatewaySettingsPatch = {};
  const feishu = expectObject(root.feishu, 'feishu');
  if (feishu) {
    patch.feishu = {
      verificationToken: expectNullableString(feishu, 'verificationToken', 'feishu'),
      encryptKey: expectNullableString(feishu, 'encryptKey', 'feishu'),
      allowedSenders: expectStringList(feishu, 'allowedSenders', 'feishu'),
      botId: expectNullableString(feishu, 'botId', 'feishu')
    };
  }
  const wecom = expectObject(root.wecom, 'wecom');
  if (wecom) {
    patch.wecom = {
      bridgeSecret: expectNullableString(wecom, 'bridgeSecret', 'wecom'),
      allowedSenders: expectStringList(wecom, 'allowedSenders', 'wecom'),
      botId: expectNullableString(wecom, 'botId', 'wecom')
    };
  }
  const webhook = expectObject(root.webhook, 'webhook');
  if (webhook) {
    patch.webhook = { allowedSenders: expectStringList(webhook, 'allowedSenders', 'webhook') };
  }
  const slack = expectObject(root.slack, 'slack');
  if (slack) {
    patch.slack = {
      signingSecret: expectNullableString(slack, 'signingSecret', 'slack'),
      allowedSenders: expectStringList(slack, 'allowedSenders', 'slack'),
      botId: expectNullableString(slack, 'botId', 'slack')
    };
  }
  return patch;
}
