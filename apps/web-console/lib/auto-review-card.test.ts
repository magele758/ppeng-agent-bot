import assert from 'node:assert/strict';
import test from 'node:test';
import { autoReviewCardFace, autoReviewKindLabelKey } from './auto-review-card.ts';

const SHELL_BLOCK = 'Shell command matches a high-risk pattern and was blocked until you approve it.';
const MCP_BLOCK = 'MCP tool call can change external state and was blocked until you approve it.';

test('Shell Auto-review card shows a Shell badge and the gate block reason [AC:auto-review-shell-mcp#AC-6]', () => {
  const face = autoReviewCardFace({
    toolName: 'bash',
    reason: `Auto-review (shell) blocked high-risk bash: ${SHELL_BLOCK}`
  });
  assert.equal(face?.kind, 'shell');
  assert.equal(face?.blockReason, SHELL_BLOCK);
  assert.equal(autoReviewKindLabelKey('shell'), 'play.approval.kindShell');
});

test('MCP Auto-review card shows an MCP badge and a different block reason [AC:auto-review-shell-mcp#AC-7]', () => {
  const face = autoReviewCardFace({
    toolName: 'mcp_invoke',
    reason: `Auto-review (mcp) blocked high-risk mcp_invoke: ${MCP_BLOCK}`
  });
  assert.equal(face?.kind, 'mcp');
  assert.equal(face?.blockReason, MCP_BLOCK);
  assert.notEqual(face?.kind, 'shell');
  assert.equal(autoReviewKindLabelKey('mcp'), 'play.approval.kindMcp');
});

test('unrelated approvals do not look like an Auto-review block [AC:auto-review-shell-mcp#AC-8]', () => {
  const ask = autoReviewCardFace({
    toolName: 'ask_user',
    reason: 'Needs more information from you'
  });
  assert.equal(ask, null);
  const ordinary = autoReviewCardFace({
    toolName: 'bash',
    reason: 'Approval required for bash (permissionMode=auto)'
  });
  assert.equal(ordinary, null);
});
