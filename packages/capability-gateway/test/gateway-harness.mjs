import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

/** In-memory daemon_control KV standing in for SqliteStateStore. */
export function fakeStore(bots = {}) {
  const kv = new Map();
  return {
    getDaemonControl: (k) => (kv.has(k) ? JSON.parse(JSON.stringify(kv.get(k))) : undefined),
    setDaemonControl: (k, v) => kv.set(k, JSON.parse(JSON.stringify(v))),
    getBot: (id) => bots[id]
  };
}

/** Minimal runtime double recording every agent interaction. */
export function fakeRuntime({ bots = {}, runSession } = {}) {
  const calls = { created: [], sent: [], ran: [], opened: [] };
  let n = 0;
  const texts = new Map();
  const runtime = {
    store: fakeStore(bots),
    calls,
    listAgents: () => [{ id: 'main' }, { id: 'general' }],
    createChatSession: (input) => {
      const id = `sess_${++n}`;
      calls.created.push({ id, ...input });
      texts.set(id, input.message);
      return { id };
    },
    sendUserMessage: (sessionId, text) => {
      calls.sent.push({ sessionId, text });
      texts.set(sessionId, text);
      return { id: sessionId };
    },
    openBot: (botId) => {
      calls.opened.push(botId);
      if (!bots[botId]) {
        const err = new Error(`bot not found: ${botId}`);
        err.name = 'NotFoundError';
        err.statusCode = 404;
        throw err;
      }
      return { bot: bots[botId], sessionId: bots[botId].canonicalSessionId, createdSession: false };
    },
    runSession: async (sessionId) => {
      calls.ran.push(sessionId);
      if (runSession) await runSession(sessionId);
    },
    getLatestAssistantText: (sessionId) => `echo:${texts.get(sessionId) ?? ''}`,
    getSession: (id) => ({ id }),
    getBot: (id) => bots[id]
  };
  return runtime;
}

const gatewayTempDirs = new Set();

export function makeCtx({ runtime, fileConfig = {}, authToken } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-sec-'));
  gatewayTempDirs.add(stateDir);
  return {
    runtime,
    repoRoot: stateDir,
    stateDir,
    env: { enabled: true, pathPrefix: '/gateway/v1', learnEnabled: false, learnDailyHourUtc: 6, authToken },
    fileConfigRef: { current: fileConfig }
  };
}

/** Remove every state dir created by makeCtx. Safe to call from after() and afterEach. */
export function cleanupGatewayTemps() {
  for (const dir of gatewayTempDirs) {
    rmSync(dir, { recursive: true, force: true });
    gatewayTempDirs.delete(dir);
  }
}

export async function call(handleGatewayHttp, ctx, { method = 'POST', path, body, rawBody, headers = {} }) {
  const text = rawBody ?? (body === undefined ? '' : JSON.stringify(body));
  const req = Readable.from(text ? [Buffer.from(text)] : []);
  req.method = method;
  req.url = `/gateway/v1${path}`;
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
      this.ended = true;
    }
  };
  const handled = await handleGatewayHttp(req, res, ctx);
  return { handled, status: res.statusCode, text: res.body, json: res.body ? safeJson(res.body) : undefined };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

let eventSeq = 0;
export function feishuMessageEvent({ token = 'tok', eventId, text = 'hi', openId = 'ou_a', chatId = 'oc_1', chatType = 'p2p' } = {}) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId ?? `ev_${Date.now()}_${++eventSeq}`,
      event_type: 'im.message.receive_v1',
      token
    },
    event: {
      sender: { sender_id: { open_id: openId } },
      message: {
        message_id: `om_${eventSeq}`,
        chat_id: chatId,
        chat_type: chatType,
        message_type: 'text',
        content: JSON.stringify({ text })
      }
    }
  };
}

export function feishuSign(rawBody, encryptKey, { timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'n1' } = {}) {
  const signature = createHash('sha256').update(timestamp + nonce + encryptKey + rawBody).digest('hex');
  return {
    'X-Lark-Request-Timestamp': timestamp,
    'X-Lark-Request-Nonce': nonce,
    'X-Lark-Signature': signature
  };
}

export function feishuEncrypt(obj, encryptKey) {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, enc]).toString('base64');
}

export const tick = () => new Promise((r) => setTimeout(r, 20));
