import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../logger.js';
import { envBool } from '../helpers.js';

const logger = createLogger('llm-debug');

export function llmPromptDebugEnabled(env: Record<string, string | undefined>): boolean {
  return envBool(env, 'RAW_AGENT_DEBUG_LLM_PROMPT', false);
}

function maxChars(env: Record<string, string | undefined>): number {
  const v = Number(env.RAW_AGENT_DEBUG_LLM_PROMPT_MAX_CHARS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function truncateText(text: string, env: Record<string, string | undefined>): string {
  const max = maxChars(env);
  if (text.startsWith('data:') && text.includes(';base64,')) {
    return text.slice(0, text.indexOf(',') + 1) + '...[BASE64_TRUNCATED]';
  }
  if (max > 0 && text.length > max) {
    return text.slice(0, max) + `...[TRUNCATED +${text.length - max}]`;
  }
  return text;
}

function sanitizeContentPart(part: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof part === 'string') return truncateText(part, env);
  if (part === null || typeof part !== 'object') return part;
  const p = part as Record<string, unknown>;
  const media = sanitizeMediaContent(p, env);
  if (media) return media;
  if (p.type === 'text' && typeof p.text === 'string') {
    return { ...p, text: truncateText(p.text, env) };
  }
  if (p.type === 'image_url' && p.image_url && typeof p.image_url === 'object') {
    const iu = p.image_url as Record<string, unknown>;
    if (typeof iu.url === 'string') {
      return { ...p, image_url: { ...iu, url: truncateText(iu.url, env) } };
    }
  }
  return p;
}

function sanitizeMessage(msg: unknown, env: Record<string, string | undefined>): unknown {
  if (msg === null || typeof msg !== 'object') return msg;
  const m = msg as Record<string, unknown>;
  if (typeof m.content === 'string') {
    return { ...m, content: truncateText(m.content, env) };
  }
  if (Array.isArray(m.content)) {
    return { ...m, content: m.content.map((c) => sanitizeContentPart(c, env)) };
  }
  return m;
}

/** Deep-clone-ish sanitization for logging OpenAI-style chat payloads (no secrets in body). */
export function sanitizeLlmRequestBodyForDebug(body: Record<string, unknown>, env: Record<string, string | undefined>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...body };
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map((msg) => sanitizeMessage(msg, env));
  }
  if (Array.isArray(result.input)) result.input = result.input.map((msg) => sanitizeMessage(msg, env));
  if (Array.isArray(result.system)) {
    result.system = result.system.map((block) => {
      if (block && typeof block === 'object' && 'text' in block && typeof (block as Record<string, unknown>).text === 'string') {
        const b = block as Record<string, unknown>;
        return { ...b, text: truncateText(b.text as string, env) };
      }
      return block;
    });
  }
  return result;
}

export async function maybeLogLlmRequest(
  env: Record<string, string | undefined>,
  ctx: { stateDir: string; sessionId: string } | undefined,
  adapterName: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!llmPromptDebugEnabled(env) || !ctx) {
    return;
  }
  const sanitized = sanitizeLlmRequestBodyForDebug(payload, env);
  const record = {
    ts: new Date().toISOString(),
    adapter: adapterName,
    sessionId: ctx.sessionId,
    payload: sanitized
  };
  const line = JSON.stringify(record);
  const mode = String(env.RAW_AGENT_DEBUG_LLM_PROMPT_MODE ?? 'file').toLowerCase();
  if (mode === 'logger') {
    logger.info(line);
    return;
  }
  const dir = join(ctx.stateDir, 'llm-debug', ctx.sessionId);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'requests.jsonl'), `${line}\n`, 'utf8');
}

function sanitizeMediaContent(p: Record<string, unknown>, env: Record<string, string | undefined>): Record<string, unknown> | undefined {
  if (p.type === 'input_audio') return { ...p, input_audio: '[MEDIA_REDACTED]' };
  if (p.type === 'video_url') return { ...p, video_url: '[MEDIA_REDACTED]' };
  if (p.type === 'image') return { ...p, source: '[MEDIA_REDACTED]' };
  if (p.type === 'input_image' && typeof p.image_url === 'string') return { ...p, image_url: truncateText(p.image_url, env) };
  return undefined;
}
