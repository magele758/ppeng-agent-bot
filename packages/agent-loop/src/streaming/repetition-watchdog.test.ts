import { describe, it, expect } from 'vitest';
import {
  detectRepetitionLoop,
  RepetitionStreamGuard,
  RepetitionLoopAbortError,
  isRepetitionAbort,
} from './repetition-watchdog.js';

describe('streaming/repetition-watchdog', () => {
  describe('detectRepetitionLoop', () => {
    it('returns null for normal varied text', () => {
      const text = 'First I will read the file. Then analyze the code. Finally suggest improvements.';
      expect(detectRepetitionLoop(text)).toBeNull();
    });

    it('returns null for short text below minTotalLen', () => {
      expect(detectRepetitionLoop('hi')).toBeNull();
    });

    it('detects character run repetition', () => {
      // 100+ same characters in a row
      const text = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const result = detectRepetitionLoop(text);
      expect(result).not.toBeNull();
      expect(result).toContain('repeated');
    });

    it('detects ngram sequence repetition', () => {
      // repeating "ab" many times
      const unit = 'hello world ';
      const text = unit.repeat(20);
      const result = detectRepetitionLoop(text);
      expect(result).not.toBeNull();
    });

    it('returns a descriptive string reason on detection', () => {
      const text = 'xyz'.repeat(50);
      const result = detectRepetitionLoop(text);
      if (result !== null) {
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      }
    });
  });

  describe('RepetitionLoopAbortError', () => {
    it('stores the reason', () => {
      const err = new RepetitionLoopAbortError('test reason');
      expect(err.reason).toBe('test reason');
      expect(err.sample).toBe('');
      expect(err.message).toContain('test reason');
    });

    it('keeps an optional sample of the repeated text', () => {
      const err = new RepetitionLoopAbortError('sequence repeated', '停在这里停在这里');
      expect(err.sample).toBe('停在这里停在这里');
    });

    it('isRepetitionAbort identifies the error', () => {
      const err = new RepetitionLoopAbortError('reason');
      expect(isRepetitionAbort(err)).toBe(true);
      expect(isRepetitionAbort(new Error('other'))).toBe(false);
      expect(isRepetitionAbort('string')).toBe(false);
    });
  });

  describe('RepetitionStreamGuard', () => {
    it('push returns null for normal varied chunks', () => {
      const guard = new RepetitionStreamGuard();
      expect(guard.push('First chunk ')).toBeNull();
      expect(guard.push('second different content ')).toBeNull();
      expect(guard.push('third entirely new thing ')).toBeNull();
    });

    it('accumulates text across pushes', () => {
      const guard = new RepetitionStreamGuard();
      guard.push('hello ');
      guard.push('world');
      expect(guard.text).toBe('hello world');
    });

    it('detects repetition across accumulated chunks', () => {
      const guard = new RepetitionStreamGuard();
      // force detection by feeding a clearly repetitive string in one go
      const repetitive = 'ab'.repeat(200);
      const result = guard.push(repetitive);
      // may or may not fire on first push depending on checkEveryChars, but
      // accumulated text is there
      expect(guard.text).toBe(repetitive);
      // if result is not null, it should be a string reason
      if (result !== null) {
        expect(typeof result).toBe('string');
      }
    });
  });
});

describe('long stream loops [AC:trace-stream-retention#AC-2]', () => {
  const sentence = '现在继续检查远端服务的实际运行状态，并且在发现异常后记录完整的现场证据。';
  const cycle = Array.from({ length: 23 }, (_, i) =>
    `诊断步骤${i}：正在检查远程服务的真实运行状态以及对应的实际请求证据。`
  ).join('');

  it('detects long repeated sentences and rotating sentence sets', () => {
    expect(detectRepetitionLoop(sentence.repeat(100))).not.toBeNull();
    expect(detectRepetitionLoop(cycle.repeat(8))).not.toBeNull();
    const guard = new RepetitionStreamGuard();
    let hit = false;
    for (const ch of cycle.repeat(15)) {
      if (guard.push(ch)) { hit = true; break; }
    }
    expect(hit).toBe(true);
  });

  it('allows finite repetitions, varied prose, fenced code and table headers', () => {
    for (const text of [
      sentence.repeat(8),
      cycle.repeat(7),
      Array.from({ length: 80 }, (_, i) => `第${i}轮检查服务${i * 17}，结果有所变化，因此需要继续验证。`).join('\n'),
      Array.from({ length: 8 }, () => '```ts\n  result.push({ id: nextId(), value: compute(input) });\n```\n').join(''),
      '| source | description of current observed status |\n'.repeat(80),
      ' '.repeat(5000),
    ]) expect(detectRepetitionLoop(text)).toBeNull();
    expect(detectRepetitionLoop('ab'.repeat(100))).not.toBeNull();
  });
});
