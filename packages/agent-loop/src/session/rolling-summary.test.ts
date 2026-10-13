import { describe, expect, it } from 'vitest';
import { foldSurface, type SurfaceNode } from './surface-invariants.js';

const node = (seq: number, text: string, extra: Partial<SurfaceNode> = {}): SurfaceNode => ({
  id: `m${seq}`, sessionId: 's', seq, role: 'system', parts: [{ type: 'text', text }],
  createdAt: '', surfaceOp: 'append', ...extra
});

describe('rolling summary fold', () => {
  const history = () => [
    node(1, 'original system'), node(2, 'old question', { role: 'user' }),
    node(3, 'old answer', { role: 'assistant' }),
    node(4, 'old summary', { key: 'compact-summary', surfaceOp: 'replace', replacesStart: 2, replacesEnd: 2 }),
    node(5, 'latest question', { role: 'user' }),
    node(6, 'new summary', { key: 'compact-summary', surfaceOp: 'replace', replacesStart: 3, replacesEnd: 3 })
  ];

  it('shows one updated summary even when its range excludes the previous snapshot [AC:context-reliability#AC-11]', () => {
    expect(foldSurface(history()).map(m => m.id)).toEqual(['m1', 'm5', 'm6']);
    expect(foldSurface(history().reverse()).map(m => m.id)).toEqual(['m1', 'm5', 'm6']);
  });

  it('hiding the newest summary does not resurrect the obsolete snapshot', () => {
    const nodes = history();
    nodes.push(node(7, '', { surfaceOp: 'hide', replacesStart: 6, replacesEnd: 6 }));
    expect(foldSurface(nodes).map(m => m.id)).toEqual(['m1', 'm5']);
  });

  it('preserves visibility of other replacement keys', () => {
    const nodes = history().map(m => m.key === 'compact-summary' ? { ...m, key: 'other-key' } : m);
    expect(foldSurface(nodes).map(m => m.id)).toEqual(['m1', 'm4', 'm5', 'm6']);
  });
});
