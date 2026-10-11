/**
 * Forever-chat commands for a Bot's canonical session.
 * `/new` compacts that same session, `/stop` aborts the current turn,
 * `/model` changes the Bot pin. Any other chat treats the text as a message.
 */

import { NotFoundError, ValidationError } from '../errors.js';
import type { SessionRecord } from '../types.js';
import { CANONICAL_BOT_CHAT_META } from './types.js';

export type ParsedBotChatCommand = { command: 'new' } | { command: 'stop' } | { command: 'model'; arg: string };

export type BotChatCommandCode =
  | 'compacted'
  | 'nothing_to_compact'
  | 'stopped'
  | 'model_set'
  | 'model_cleared'
  | 'model_unknown'
  | 'model_ambiguous'
  | 'model_usage';

export interface BotChatCommandResult {
  handled: true;
  command: ParsedBotChatCommand['command'];
  code: BotChatCommandCode;
  ok: boolean;
  sessionId: string;
  botId: string;
  reply: string;
  arg?: string;
  modelOverride?: { providerId: string; modelId: string } | null;
}

export interface BotChatCommandHost {
  getSession(sessionId: string): SessionRecord | undefined;
  appendSystemNote(sessionId: string, text: string): void;
  cancelSession(sessionId: string): void;
  updateBot(botId: string, patch: { modelOverride: { providerId: string; modelId: string } | null }): void;
  modelOptions(): readonly { providerId: string; modelId: string; source?: string }[];
  compactSession(sessionId: string): Promise<{ replaced?: { startSeq: number; endSeq: number } }>;
}

const MODEL_CLEAR = /^(default|follow|clear)$/i;

/** Whole-message commands only. A sentence that mentions `/new` stays a normal message. */
export function parseBotChatCommand(text: string): ParsedBotChatCommand | null {
  const trimmed = text.trim();
  if (/^\/new$/i.test(trimmed)) return { command: 'new' };
  if (/^\/stop$/i.test(trimmed)) return { command: 'stop' };
  const model = /^\/model(?:\s+(\S(?:.*\S)?))?$/i.exec(trimmed);
  if (!model) return null;
  return { command: 'model', arg: (model[1] ?? '').trim() };
}

export function canonicalBotIdFromSession(
  session: { metadata?: Record<string, unknown> } | undefined
): string | undefined {
  const meta = session?.metadata;
  if (!meta || meta[CANONICAL_BOT_CHAT_META] !== true) return undefined;
  const botId = meta.botId;
  return typeof botId === 'string' && botId.trim() ? botId.trim() : undefined;
}

export function resolveBotModelArg(
  arg: string,
  options: readonly { providerId: string; modelId: string; source?: string }[]
):
  | { ok: true; kind: 'set'; modelOverride: { providerId: string; modelId: string } }
  | { ok: true; kind: 'clear' }
  | { ok: true; kind: 'usage' }
  | { ok: false; kind: 'unknown' | 'ambiguous' } {
  const text = arg.trim();
  if (!text) return { ok: true, kind: 'usage' };
  if (MODEL_CLEAR.test(text) || text === '跟随默认') return { ok: true, kind: 'clear' };
  const pickable = options.filter((option) => option.source !== 'env' && option.providerId !== '__env__');
  const sep = text.includes('::') ? '::' : text.includes('/') ? '/' : '';
  if (sep) {
    const idx = text.indexOf(sep);
    const providerId = text.slice(0, idx).trim();
    const modelId = text.slice(idx + sep.length).trim();
    const hit = pickable.find((option) => option.providerId === providerId && option.modelId === modelId);
    if (!hit) return { ok: false, kind: 'unknown' };
    return { ok: true, kind: 'set', modelOverride: { providerId: hit.providerId, modelId: hit.modelId } };
  }
  const hits = pickable.filter((option) => option.modelId === text);
  if (hits.length === 1) {
    const hit = hits[0]!;
    return { ok: true, kind: 'set', modelOverride: { providerId: hit.providerId, modelId: hit.modelId } };
  }
  if (hits.length > 1) return { ok: false, kind: 'ambiguous' };
  return { ok: false, kind: 'unknown' };
}

function replyFor(code: BotChatCommandCode, detail?: string): string {
  switch (code) {
    case 'compacted':
      return '已压缩当前对话，仍在同一条会话里继续。';
    case 'nothing_to_compact':
      return '当前对话没有可压缩的内容，仍是同一条会话。';
    case 'stopped':
      return '已停止当前回合。';
    case 'model_set':
      return `已切换模型为 ${detail ?? ''}。`;
    case 'model_cleared':
      return '已改回跟随默认模型。';
    case 'model_unknown':
      return `未知模型「${detail ?? ''}」，当前模型未改变。`;
    case 'model_ambiguous':
      return `模型名「${detail ?? ''}」对应多个模型，请写成 供应商/模型。`;
    case 'model_usage':
      return '用法：/model 供应商/模型，或 /model default 跟随默认。';
    default: {
      const neverCode: never = code;
      return neverCode;
    }
  }
}

function note(host: BotChatCommandHost, sessionId: string, text: string): void {
  try {
    host.appendSystemNote(sessionId, text);
  } catch {
    /* The in-flight turn owns the transcript writer. The channel reply still stands. */
  }
}

function done(
  parsed: ParsedBotChatCommand,
  sessionId: string,
  botId: string,
  code: BotChatCommandCode,
  ok: boolean,
  extra?: { arg?: string; modelOverride?: { providerId: string; modelId: string } | null; detail?: string }
): BotChatCommandResult {
  return {
    handled: true,
    command: parsed.command,
    code,
    ok,
    sessionId,
    botId,
    reply: replyFor(code, extra?.detail),
    ...(extra?.arg !== undefined ? { arg: extra.arg } : {}),
    ...(extra && 'modelOverride' in extra ? { modelOverride: extra.modelOverride } : {})
  };
}

export async function applyBotChatCommand(
  host: BotChatCommandHost,
  sessionId: string,
  text: string
): Promise<BotChatCommandResult | null> {
  const parsed = parseBotChatCommand(text);
  if (!parsed) return null;
  const session = host.getSession(sessionId);
  const botId = canonicalBotIdFromSession(session);
  if (!botId || !session) return null;

  switch (parsed.command) {
    case 'new': {
      const compacted = await host.compactSession(sessionId);
      const code: BotChatCommandCode = compacted.replaced ? 'compacted' : 'nothing_to_compact';
      const reply = replyFor(code);
      note(host, sessionId, reply);
      return done(parsed, sessionId, botId, code, true);
    }
    case 'stop': {
      host.cancelSession(sessionId);
      const reply = replyFor('stopped');
      note(host, sessionId, reply);
      return done(parsed, sessionId, botId, 'stopped', true);
    }
    case 'model': {
      const resolved = resolveBotModelArg(parsed.arg, host.modelOptions());
      if (!resolved.ok) {
        const code: BotChatCommandCode = resolved.kind === 'ambiguous' ? 'model_ambiguous' : 'model_unknown';
        const reply = replyFor(code, parsed.arg);
        note(host, sessionId, reply);
        return done(parsed, sessionId, botId, code, false, { arg: parsed.arg });
      }
      if (resolved.kind === 'usage') {
        const reply = replyFor('model_usage');
        note(host, sessionId, reply);
        return done(parsed, sessionId, botId, 'model_usage', true, { arg: parsed.arg });
      }
      const modelOverride = resolved.kind === 'clear' ? null : resolved.modelOverride;
      try {
        host.updateBot(botId, { modelOverride });
      } catch (error) {
        if (error instanceof ValidationError || error instanceof NotFoundError) {
          const reply = replyFor('model_unknown', parsed.arg);
          note(host, sessionId, reply);
          return done(parsed, sessionId, botId, 'model_unknown', false, { arg: parsed.arg });
        }
        throw error;
      }
      const code: BotChatCommandCode = modelOverride ? 'model_set' : 'model_cleared';
      const detail = modelOverride ? `${modelOverride.providerId}/${modelOverride.modelId}` : undefined;
      const reply = replyFor(code, detail);
      note(host, sessionId, reply);
      return done(parsed, sessionId, botId, code, true, { arg: parsed.arg, modelOverride, detail });
    }
    default: {
      const neverParsed: never = parsed;
      return neverParsed;
    }
  }
}
