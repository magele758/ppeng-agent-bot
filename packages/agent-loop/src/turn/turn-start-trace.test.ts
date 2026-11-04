import { describe, expect, it } from 'vitest';
import { turnStartTraceData } from './turn-start-trace.js';

describe('turn start execution log', () => {
  it('names the model and the tools offered this turn [AC:execution-log-analysis#AC-7]', () => {
    expect(turnStartTraceData({
      turn: 2,
      adapterName: 'openai-compatible',
      modelName: 'gpt-test',
      promptCacheKey: 'ppeng:s1:abc',
      toolNames: ['read_file', 'bash'],
    })).toEqual({
      turn: 2,
      adapter: 'openai-compatible',
      model: 'gpt-test',
      promptCacheKey: 'ppeng:s1:abc',
      tools: ['read_file', 'bash'],
    });
  });

  it('omits an empty model name and an empty cache key', () => {
    expect(turnStartTraceData({
      turn: 0,
      adapterName: 'heuristic',
      toolNames: [],
    })).toEqual({ turn: 0, adapter: 'heuristic', tools: [] });
  });
});
