import { describe, expect, it } from 'vitest';
import { admitProductionWrite, patternBProductionEntryOpen, PATTERN_B_PRODUCTION_ENTRY_OPEN } from './production-entry.js';
import { PATTERN_B_PRODUCTION_ENTRY } from './types.js';
import * as handoff from '../index.js';

describe('Pattern B production entry', () => {
  it('stays closed and admits no production write', () => {
    expect(PATTERN_B_PRODUCTION_ENTRY).toBe('closed');
    expect(PATTERN_B_PRODUCTION_ENTRY_OPEN).toBe(false);
    expect(patternBProductionEntryOpen()).toBe(false);
    expect(admitProductionWrite()).toEqual({
      allowed: false,
      code: 'entry_closed',
      reason: 'Pattern B production entry is closed',
    });
  });

  it('is not re-exported from the trajectory-handoff entry', () => {
    expect('admitProductionWrite' in handoff).toBe(false);
    expect('createMemoryIntegrationStore' in handoff).toBe(false);
    expect('admitWorkerWrite' in handoff).toBe(false);
    expect('createMemoryLifecycleStore' in handoff).toBe(false);
  });
});
