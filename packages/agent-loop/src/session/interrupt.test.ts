import { describe, expect, it } from 'vitest';
import { selectExecutableToolCalls, unmatchedToolCallsFromFold } from './interrupt.js';

describe('reused tool-call ids', () => {
  const folded = [
    {
      parts: [
        { type: 'tool_call' as const, toolCallId: 'heuristic_read_dir', name: 'echo', input: { n: 1 } },
      ],
    },
    {
      parts: [
        {
          type: 'tool_result' as const,
          toolCallId: 'heuristic_read_dir',
          name: 'echo',
          ok: true,
          content: 'old',
        },
      ],
    },
    {
      parts: [
        { type: 'tool_call' as const, toolCallId: 'heuristic_read_dir', name: 'echo', input: { n: 2 } },
      ],
    },
  ];

  it('reconstructs only the call that reopened the id', () => {
    expect(unmatchedToolCallsFromFold(folded)).toEqual([
      { type: 'tool_call', toolCallId: 'heuristic_read_dir', name: 'echo', input: { n: 2 } },
    ]);
  });

  it('filters the current wave by unmatched ids and does not replay history', () => {
    const wave = [{ toolCallId: 'heuristic_read_dir', name: 'echo', input: { n: 2 } }];
    const historical = [
      { toolCallId: 'heuristic_read_dir', name: 'echo', input: { n: 1 } },
      { toolCallId: 'heuristic_read_dir', name: 'echo', input: { n: 2 } },
    ];
    expect(selectExecutableToolCalls(wave, undefined, () => historical)).toEqual(wave);
    expect(selectExecutableToolCalls(wave, { reported: false, ids: [] }, () => historical)).toEqual(wave);
  });

  it('does not fold when the gate reports no closures', () => {
    let foldedCalls = 0;
    const wave = [{ toolCallId: 'heuristic_read_dir' }];
    const executable = selectExecutableToolCalls(wave, { reported: true, ids: [] }, () => {
      foldedCalls += 1;
      return [{ toolCallId: 'heuristic_read_dir' }, { toolCallId: 'heuristic_read_dir' }];
    });
    expect(executable).toEqual(wave);
    expect(foldedCalls).toBe(0);
  });
});
