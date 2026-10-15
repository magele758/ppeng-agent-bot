export type ChannelType =
  | 'webhook'
  | 'http_post'
  | 'feishu_bot'
  | 'wecom_group_bot'
  | 'slack'
  | 'telegram'
  | 'email';

export interface ChannelSpec {
  id: string;
  type: ChannelType;
  /**
   * Webhook / email_http: POST URL.
   * Slack: `chat.postMessage` URL, or a conversation id when it is not http(s).
   * Telegram: Bot API origin, or a chat id when it is not http(s).
   * Feishu: receive id. WeCom: webhook URL.
   */
  url: string;
  /**
   * Extra headers. Slack / Telegram may carry the bot token here
   * (`Authorization: Bearer …` or `Bearer env:VAR` / `env:VAR`).
   * The token value is read at send time and is not written to logs.
   */
  headers?: Record<string, string>;
  /** For slack-compatible webhooks: use { "text": "..." } wrapping */
  payloadMode?: 'json_text' | 'raw_json';
  /** Lark / Feishu group bot: use chat_id from receive_id_v2 when sending */
  feishuReceiveIdType?: 'open_id' | 'user_id' | 'union_id' | 'chat_id';
  /** WeCom group bot key (path segment) if url is base only */
  wecomKey?: string;
  /**
   * Env var name whose value is the Slack or Telegram bot token.
   * Configuration stores the name only. Used when `headers` does not carry a token.
   */
  tokenEnv?: string;
  /**
   * Slack conversation id, Telegram chat id, or email recipient.
   * Required for Slack / Telegram when `url` is an http(s) endpoint.
   */
  target?: string;
  /** Subject field on the email_http JSON body. */
  subject?: string;
}

/** Feishu / Lark event subscription (inbound). */
export interface FeishuProviderSpec {
  enabled?: boolean;
  /** Must match app "Verification Token" in Feishu developer console (Lab settings override) */
  verificationToken?: string;
  /** Optional Encrypt Key (base64) — enables decrypt of `encrypt` payloads */
  encryptKey?: string;
  /** Default internal agent id for chat turns */
  defaultAgentId?: string;
  /** Outbound channel id from `channels[]` to reply in thread (must be type feishu_bot) */
  replyChannelId?: string;
  /** Route chats into this Bot's canonical session (Lab settings override). */
  botId?: string;
}

/** WeCom: outbound group bot + optional simple bridge inbound. */
export interface WeComProviderSpec {
  enabled?: boolean;
  /**
   * Shared secret for POST /wecom/bridge (required; Lab settings override).
   * Clients send it in `x-wecom-bridge-secret`. A JSON `secret` field is ignored.
   * `x-wecom-bridge-timestamp` is Unix seconds and must be within 5 minutes.
   */
  bridgeSecret?: string;
  defaultAgentId?: string;
  botId?: string;
  /** channels[].id with type wecom_group_bot */
  replyChannelId?: string;
}

export interface GatewayAgentRoute {
  /** Stable id used in URL: POST .../agents/:agentId/invoke */
  agentId: string;
  /** Optional API key for this route (header X-Agent-Route-Key) */
  routeKey?: string;
  /** Persist chat across invokes when true (default true) */
  stickySession?: boolean;
}

export interface GatewayProvidersConfig {
  feishu?: FeishuProviderSpec;
  wecom?: WeComProviderSpec;
}

export interface LearnConfig {
  /** RSS or Atom feed URLs */
  feeds: string[];
  /** Relative to repo root; digest SKILL.md is written here */
  skillsSubdir: string;
  /** Max items to keep per run per feed */
  maxItemsPerFeed?: number;
}

export interface GatewayFileConfig {
  channels?: ChannelSpec[];
  learn?: LearnConfig;
  /** Inbound IM + internal agent routing (OpenClaw-style) */
  providers?: GatewayProvidersConfig;
  /** Internal HTTP routes per agent */
  agentRoutes?: GatewayAgentRoute[];
}

export interface GatewayEnvOptions {
  enabled: boolean;
  /** URL path prefix, e.g. /gateway/v1 */
  pathPrefix: string;
  configPath?: string;
  learnEnabled: boolean;
  /** UTC hour 0–23 to run daily learn (once per calendar day) */
  learnDailyHourUtc: number;
  /** Optional shared secret for X-Gateway-Token header */
  authToken?: string;
}

export interface ParsedFeedItem {
  title: string;
  link: string;
}
