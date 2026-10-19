/**
 * L0 public barrel: session message types + surface invariants.
 * Import from `@ppeng/agent-core/types`.
 */

export type {
  SessionMessage,
  MessageReplyTo,
  SessionRecord,
  SessionMode,
  SessionStatus,
  MessagePart,
  MessageRole,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ImagePart,
  ReasoningPart,
  AgentSpec,
  ToolContract,
  RunContext,
  ModelTurnResult,
  ModelAdapter
} from '../types.js';

export {
  foldSurface,
  foldCanonicalJson,
  unmatchedToolCallIds,
  isToolWaveOpen,
  parseSurfaceOp,
  SurfaceInvariantError
} from '../session/surface-invariants.js';
export type { SurfaceOp, SurfaceNode } from '../session/surface-invariants.js';
