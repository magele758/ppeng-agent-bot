import { describe, expect, it } from 'vitest';
import { capSessionMap, SESSION_CACHE_MAX } from './prepare-view.js';

describe('capSessionMap', () => {
  it('drops the oldest session id once the map passes the cap', () => {
    const map = new Map<string, { phase: string }>();
    for (let i = 0; i < SESSION_CACHE_MAX + 1; i += 1) {
      map.set(`s${i}`, { phase: 'explore' });
    }
    capSessionMap(map);
    expect(map.size).toBe(SESSION_CACHE_MAX);
    expect(map.has('s0')).toBe(false);
    expect(map.has(`s${SESSION_CACHE_MAX}`)).toBe(true);
  });
});
