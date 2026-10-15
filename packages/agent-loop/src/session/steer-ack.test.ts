import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../types.js';
import { decideSteerAdmission, sessionSteersImmediately } from './steer-ack.js';
import { resolveSteerInboxTarget } from './steer-drain.js';

function session(patch: Pick<SessionRecord, 'mode' | 'status' | 'metadata'>): SessionRecord {
  return {
    id: 's1',
    title: 't',
    agentId: 'general',
    background: false,
    todo: [],
    createdAt: 't0',
    updatedAt: 't0',
    ...patch
  };
}

const bot = session({
  mode: 'chat',
  status: 'running',
  metadata: { canonicalBotChat: true }
});

describe('canonical bot steer admission', () => {
  it('steers a running bot even when interrupt policy is queue or disabled [AC:bot-immediate-steer#AC-1] [AC:bot-immediate-steer#AC-3]', () => {
    expect(sessionSteersImmediately(bot)).toBe(true);
    expect(decideSteerAdmission({ text: 'hello', session: bot, interruptPolicy: 'queue' })).toEqual({
      admit: true,
      status: 'steered'
    });
    expect(decideSteerAdmission({ text: 'hello', session: bot, interruptPolicy: 'disabled' })).toEqual({
      admit: true,
      status: 'steered'
    });
    expect(
      resolveSteerInboxTarget({
        immediate: true,
        explicitTarget: 'next-run',
        interruptPolicy: 'queue',
        sessionStatus: 'running'
      })
    ).toBe('next-step');
  });

  it('still asks ordinary sessions to queue or reject [AC:bot-immediate-steer#AC-2]', () => {
    const plain = session({ mode: 'chat', status: 'running', metadata: {} });
    expect(sessionSteersImmediately(plain)).toBe(false);
    expect(decideSteerAdmission({ text: 'hello', session: plain, interruptPolicy: 'queue' })).toEqual({
      admit: true,
      status: 'started'
    });
    expect(decideSteerAdmission({ text: 'hello', session: plain, interruptPolicy: 'disabled' })).toEqual({
      admit: false,
      reason: 'steer_disabled'
    });
    expect(
      resolveSteerInboxTarget({
        explicitTarget: 'next-run',
        interruptPolicy: 'queue',
        sessionStatus: 'running'
      })
    ).toBe('next-run');
  });
});
