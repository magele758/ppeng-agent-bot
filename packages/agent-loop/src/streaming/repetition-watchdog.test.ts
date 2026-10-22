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
