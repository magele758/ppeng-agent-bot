import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import {
  emptyReplyQuoteMemory,
  quoteFromReply,
  readStoredReplyTo,
  rememberPendingReply,
  stampReplyQuotes,
  withReplyTo,
  type QuoteableReply,
  type ReplyQuote,
  type ReplyTo
} from '../lib/reply-quote.ts';

const localRequire = createRequire(import.meta.url);
const copy: Record<string, string> = {};
function walk(value: unknown, prefix: string) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') copy[path] = child;
    else walk(child, path);
  }
}
walk(zh.play, 'play');

function translate(key: string, vars?: Record<string, string>): string {
  let text = copy[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, value);
  return text;
}

function loadQuoteUi() {
  const source = readFileSync(new URL('./ReplyQuote.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as Record<string, React.ComponentType<Record<string, unknown>>> };
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react') return React;
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: translate }) };
    if (id === '@/lib/reply-quote') return localRequire('../lib/reply-quote.ts');
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  return mod.exports;
}

const ui = loadQuoteUi();

function render(component: React.ComponentType<Record<string, unknown>>, props: Record<string, unknown>): string {
  return renderToStaticMarkup(React.createElement(component, props));
}

const botReply: QuoteableReply = {
  messageId: 'msg-rain',
  botId: 'bot-north',
  botName: '北风',
  text: '今天会下雨',
  author: 'bot'
};

function composer(quote: ReplyQuote | null, surface: 'direct' | 'group'): string {
  return render(ui.ComposerReplyQuote!, { quote, surface, onCancel: () => undefined });
}

function bubble(replyTo: ReplyTo | null, botName: string): string {
  return render(ui.MessageReplyQuote!, { replyTo, botName });
}

function actions(replies: QuoteableReply[]): string {
  return renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-testid': 'reply-feed' },
      replies.map((reply) =>
        React.createElement(ui.BotReplyQuoteAction!, {
          key: reply.messageId,
          reply,
          onQuote: () => undefined
        })
      )
    )
  );
}

test('取消引用后再发送，消息上没有引用 [AC:bot-reply-quote#AC-2]', () => {
  const quote = quoteFromReply(botReply);
  assert.ok(quote);
  for (const surface of ['direct', 'group'] as const) {
    const selected = composer(quote, surface);
    assert.match(selected, /data-testid="composer-reply-quote"/);
    assert.match(selected, new RegExp(`data-surface="${surface}"`));
    assert.match(selected, /data-testid="composer-reply-quote-cancel"/);
    assert.match(selected, /今天会下雨/);
    assert.match(selected, /北风/);
    assert.match(selected, /取消引用/);
  }

  const cancelled = null;
  for (const surface of ['direct', 'group'] as const) {
    const cleared = composer(cancelled, surface);
    assert.equal(cleared.includes('composer-reply-quote'), false);
    assert.equal(cleared.includes('今天会下雨'), false);
  }

  const direct = withReplyTo({ message: '普通新消息' }, cancelled);
  const room = withReplyTo({ text: '普通新消息', idempotencyKey: 'idem-1' }, cancelled);
  assert.equal('replyTo' in direct, false);
  assert.equal('replyTo' in room, false);
  assert.equal(direct.message, '普通新消息');
  assert.equal(room.text, '普通新消息');

  const sent = bubble(null, '北风');
  assert.equal(sent.includes('message-reply-quote'), false);
  assert.equal(sent.includes('今天会下雨'), false);
});

test('很长的 Bot 回复在发出的消息上只显示短摘录 [AC:bot-reply-quote#AC-3]', () => {
  const long = '长'.repeat(180);
  const reply: QuoteableReply = {
    messageId: 'msg-long',
    botId: 'bot-north',
    botName: '北风',
    text: long,
    author: 'bot'
  };
  const quote = quoteFromReply(reply);
  assert.ok(quote);
  assert.equal(quote.excerpt.length, 120);
  assert.equal(long.startsWith(quote.excerpt), true);
  assert.notEqual(quote.excerpt, long);

  const direct = withReplyTo({ message: '针对这句' }, quote);
  const room = withReplyTo({ text: '针对这句', idempotencyKey: 'idem-long' }, quote);
  assert.deepEqual(direct.replyTo, { messageId: 'msg-long', botId: 'bot-north', excerpt: quote.excerpt });
  assert.deepEqual(room.replyTo, direct.replyTo);
  assert.ok(direct.replyTo);
  assert.ok(direct.replyTo.excerpt.length <= 120);

  for (const surface of ['direct', 'group'] as const) {
    const selected = composer(quote, surface);
    assert.match(selected, /data-message-id="msg-long"/);
    assert.match(selected, /data-bot-id="bot-north"/);
    assert.match(selected, /北风/);
    assert.equal(selected.includes(long), false);
    assert.match(selected, new RegExp(quote.excerpt));
  }

  const memory = emptyReplyQuoteMemory();
  rememberPendingReply(memory, '针对这句', quote, ['msg-long', 'old-user']);
  const stamped = stampReplyQuotes(
    [
      { id: 'old-user', role: 'user', parts: [{ type: 'text', text: '针对这句' }] },
      { id: 'msg-long', role: 'assistant', parts: [{ type: 'text', text: long }] },
      { id: 'new-user', role: 'user', parts: [{ type: 'text', text: '针对这句' }] }
    ],
    memory
  );
  assert.equal(readStoredReplyTo(stamped[0]), null);
  const sentReply = readStoredReplyTo(stamped[2]);
  assert.deepEqual(sentReply, { messageId: 'msg-long', botId: 'bot-north', excerpt: quote.excerpt });

  const sent = bubble(sentReply, '北风');
  assert.match(sent, /data-testid="message-reply-quote"/);
  assert.match(sent, /data-message-id="msg-long"/);
  assert.match(sent, /data-bot-id="bot-north"/);
  assert.match(sent, /北风 说/);
  assert.match(sent, new RegExp(quote.excerpt));
  assert.equal(sent.includes(long), false);
});

test('滚到较早的 Bot 回复后仍可引用，效果与引用刚出现的回复相同 [AC:bot-reply-quote#AC-6]', () => {
  const olderText = '较早的'.repeat(50);
  const freshText = '刚出现的回复';
  const older: QuoteableReply = {
    messageId: 'msg-older',
    botId: 'bot-north',
    botName: '北风',
    text: olderText,
    author: 'bot'
  };
  const fresh: QuoteableReply = {
    messageId: 'msg-fresh',
    botId: 'bot-north',
    botName: '北风',
    text: freshText,
    author: 'bot'
  };
  const mine: QuoteableReply = {
    messageId: 'msg-mine',
    botId: 'user-1',
    botName: '我',
    text: '这是我自己的消息',
    author: 'user'
  };

  const scrolled = actions([older, mine]);
  const latest = actions([fresh]);
  const starts = scrolled.match(/data-testid="reply-quote-start"/g) ?? [];
  assert.equal(starts.length, 1);
  assert.match(scrolled, /data-message-id="msg-older"/);
  assert.match(scrolled, /引用/);
  assert.equal(scrolled.includes('data-message-id="msg-mine"'), false);
  assert.equal(scrolled.includes(olderText), false);
  assert.match(latest, /data-testid="reply-quote-start"/);
  assert.match(latest, /data-message-id="msg-fresh"/);
  assert.equal(quoteFromReply(mine), null);

  const olderQuote = quoteFromReply(older);
  const freshQuote = quoteFromReply(fresh);
  assert.ok(olderQuote);
  assert.ok(freshQuote);
  const olderSent = withReplyTo({ message: '就这句' }, olderQuote);
  const freshSent = withReplyTo({ message: '就这句' }, freshQuote);
  assert.deepEqual(Object.keys(olderSent.replyTo ?? {}).sort(), ['botId', 'excerpt', 'messageId']);
  assert.deepEqual(Object.keys(freshSent.replyTo ?? {}).sort(), Object.keys(olderSent.replyTo ?? {}).sort());
  assert.equal(olderSent.replyTo?.messageId, 'msg-older');
  assert.equal(freshSent.replyTo?.messageId, 'msg-fresh');
  assert.equal(olderSent.replyTo?.botId, freshSent.replyTo?.botId);
  assert.ok((olderSent.replyTo?.excerpt.length ?? 0) <= 120);
  assert.equal(olderSent.replyTo?.excerpt, olderText.slice(0, 120));
  assert.equal(freshSent.replyTo?.excerpt, freshText);
  assert.notEqual(olderSent.replyTo?.excerpt, olderText);

  for (const surface of ['direct', 'group'] as const) {
    const olderComposer = composer(olderQuote, surface);
    const freshComposer = composer(freshQuote, surface);
    assert.match(olderComposer, /data-message-id="msg-older"/);
    assert.match(freshComposer, /data-message-id="msg-fresh"/);
    assert.match(olderComposer, /北风/);
    assert.match(freshComposer, /北风/);
    assert.equal(olderComposer.includes(olderText), false);
    assert.match(freshComposer, /刚出现的回复/);
  }

  const olderBubble = bubble(olderSent.replyTo ?? null, olderQuote.botName);
  const freshBubble = bubble(freshSent.replyTo ?? null, freshQuote.botName);
  assert.match(olderBubble, /data-testid="message-reply-quote"/);
  assert.match(freshBubble, /data-testid="message-reply-quote"/);
  assert.match(olderBubble, /data-message-id="msg-older"/);
  assert.match(freshBubble, /data-message-id="msg-fresh"/);
  assert.match(olderBubble, /北风 说/);
  assert.match(freshBubble, /北风 说/);
  assert.match(olderBubble, new RegExp(olderQuote.excerpt));
  assert.match(freshBubble, /刚出现的回复/);
  assert.equal(olderBubble.includes(olderText), false);
});
