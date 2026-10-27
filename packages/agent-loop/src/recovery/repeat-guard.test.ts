import { describe, expect, it } from 'vitest';
import {
  applyRepeatGuard,
  classifyModelTier,
  DEFAULT_REPEAT_GUARD_MODE,
  loopGuardStopReason,
  modelIdentity,
  parseRepeatGuardMode,
  repeatLimitsActive,
  resolveRepeatGuardMode,
} from './repeat-guard.js';

const CONTENT =
  'repeat detection: same tool-call content in 2 consecutive tool rounds (read_file, grep_files)';

describe('repeat guard model tier', () => {
  it('treats heuristic and small names as weak, and unknown names as strong [AC:loop-guard-model-switch#AC-1] [AC:loop-guard-model-switch#AC-2]', () => {
    const weak = [
      { adapterName: 'heuristic' },
      { providerKind: 'heuristic' },
      { modelName: 'heuristic' },
      { providerId: '__heuristic__' },
      { modelName: 'gpt-4o-mini' },
      { modelName: 'GPT-4o-Mini' },
      { modelName: 'gemini-2.5-flash' },
      { modelName: 'claude-3-haiku-20240307' },
      { modelName: 'o3-mini' },
      { modelName: 'gpt-5-nano' },
      { modelName: 'small' },
      { modelName: 'gemini-lite' },
    ];
    for (const identity of weak) {
      expect(classifyModelTier(identity), JSON.stringify(identity)).toBe('weak');
    }

    const strong = [
      { modelName: 'gpt-4o', adapterName: 'openai-compatible' },
      { modelName: 'gpt-4.1' },
      { modelName: 'gpt-5' },
      { modelName: 'claude-opus-4-5' },
      { modelName: 'claude-sonnet-4' },
      { modelName: 'gemini-2.5-pro' },
      { modelName: 'grok-4' },
      { modelName: 'o1-preview' },
      { modelName: 'o3' },
      { modelName: 'my-private-model' },
      { modelName: 'flashlight' },
      { modelName: 'admini' },
      { adapterName: 'stub' },
      {},
      { modelName: 'gpt-4o', providerId: 'heuristic', adapterName: 'openai-compatible' },
    ];
    for (const identity of strong) {
      expect(classifyModelTier(identity), JSON.stringify(identity)).toBe('strong');
    }

    expect(
      classifyModelTier(
        modelIdentity({
          adapterName: 'openai-compatible',
          metadata: { modelOverride: { providerId: 'openai', modelId: 'gpt-4o-mini' } },
        })
      )
    ).toBe('weak');
    expect(parseRepeatGuardMode('nope')).toBeUndefined();
    expect(DEFAULT_REPEAT_GUARD_MODE).toBe('weak');
  });

  it('keeps a weak-model content repeat under the default [AC:loop-guard-model-switch#AC-1]', () => {
    const decision = applyRepeatGuard({
      identity: { adapterName: 'heuristic' },
      decision: { abort: true, reason: CONTENT },
    });
    expect(decision.abort).toBe(true);
    expect(loopGuardStopReason(decision.abort ? decision.reason : '')).toBe('repeat_detection');
  });

  it('drops a strong-model content repeat under the default [AC:loop-guard-model-switch#AC-2]', () => {
    const decision = applyRepeatGuard({
      store: { getDaemonControl: () => undefined },
      identity: { modelName: 'gpt-4o', adapterName: 'openai-compatible' },
      decision: { abort: true, reason: CONTENT },
    });
    expect(decision).toEqual({ abort: false });
    expect(repeatLimitsActive('weak', 'strong')).toBe(false);
  });

  it('applies content repeats to strong models when the saved mode is all [AC:loop-guard-model-switch#AC-3]', () => {
    const store = {
      getDaemonControl: (key: string) => (key === 'loop_settings' ? { repeatGuard: 'all' } : undefined),
    };
    expect(resolveRepeatGuardMode(store)).toBe('all');
    const decision = applyRepeatGuard({
      store,
      identity: { modelName: 'claude-sonnet-4' },
      decision: { abort: true, reason: CONTENT },
    });
    expect(decision.abort).toBe(true);
  });

  it('drops content repeats for weak models when the saved mode is off [AC:loop-guard-model-switch#AC-4]', () => {
    const store = {
      getDaemonControl: (key: string) => (key === 'loop_settings' ? { repeatGuard: 'off' } : undefined),
    };
    const decision = applyRepeatGuard({
      store,
      identity: { adapterName: 'heuristic' },
      decision: { abort: true, reason: CONTENT },
    });
    expect(decision).toEqual({ abort: false });
    expect(repeatLimitsActive('off', 'weak')).toBe(false);
  });

  it('still aborts a tool-failure streak when repeat detection is off [AC:conversation-loop-defaults#AC-6]', () => {
    const decision = applyRepeatGuard({
      store: {
        getDaemonControl: () => ({ repeatGuard: 'off' }),
      },
      identity: { adapterName: 'heuristic' },
      decision: { abort: true, reason: 'tool "read_file" failed 3 times in a row' },
    });
    expect(decision.abort).toBe(true);
    expect(loopGuardStopReason(decision.abort ? decision.reason : '')).toBe('tool_loop');
  });
});
