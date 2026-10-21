/**
 * `@ppeng/agent-loop/model` — model adapters plus the pure helpers around
 * them (usage, cost, stop-reason, reasoning promotion, refusal guard).
 * Node-only: `llm-prompt-debug` touches the filesystem.
 */

export {
  AnthropicMessagesAdapter,
  HeuristicModelAdapter,
  HybridModelRouterAdapter,
  OpenAICompatibleAdapter,
  OpenAiChatAdapter,
  OpenAiResponsesAdapter,
  createModelAdapterFromEnv,
  normalizeOpenAiHttpKind,
  runOpenAiVisionTurn,
  textSummaryFromParts,
  HEURISTIC_LONG_BASH_COMMAND,
  HEURISTIC_LONG_BASH_MARKER,
} from './model-adapters.js';
export type {
  AnthropicMessagesAdapterOptions,
  OpenAICompatibleAdapterOptions,
  OpenAiChatAdapterOptions,
  OpenAiHttpKind,
  OpenAiResponsesAdapterOptions,
} from './model-adapters.js';

export {
  UpstreamHttpError,
  UpstreamStreamError,
  parseRetryAfterMs,
  retryAfterMsOf
} from './upstream-error.js';
export { isToolUseFinish, resolveModelStopReason } from './stop-reason.js';
export type { ModelStopReason } from './stop-reason.js';
export { correctWrongStopSignal } from './correct-stop-reason.js';
export { promoteAssistantReasoning, promoteReasoningToTextIfNeeded } from './promote-reasoning.js';
export {
  applyRefusalPreservationGuard,
  buildRefusalPreservationReminder,
  detectRefusalRedirectPattern,
  isRedirectAttempt,
  isRefusalMessage,
} from './refusal-preservation.js';
export type { RefusalPreservationResult } from './refusal-preservation.js';

export {
  isTruncatedFinish,
  mergeUsage,
  normalizeAnthropicUsage,
  normalizeOpenAiUsage,
  splitCumulativePromptTokens,
} from './usage.js';
export {
  DEFAULT_MODEL_PRICES,
  estimateUsageCostUsd,
  mergeCostUsd,
  resolveModelPrice,
} from './token-cost.js';
export type { CostEstimate, TokenPricePerMillion } from './token-cost.js';
export { estimateMessageTokens, estimateTokensFromText } from './token-estimate.js';

export { parseModelToolArguments } from './parse-tool-arguments.js';
export { TOOL_INFRA_PROBLEM_TYPE, formatToolResultForLlm, toolInfraProblem } from './tool-result-problem.js';

export { formatRemoteEnvInspection, inspectRemoteEnv, normalizeRemoteSecret } from './remote-env.js';
export type { RemoteEnvInspection } from './remote-env.js';
export {
  normalizeUpstreamRequestId,
  pickUpstreamRequestIdFromHeaders,
  pickUpstreamRequestIdFromJsonText,
  pickUpstreamRequestIdFromRecord,
  resolveUpstreamRequestId,
  unwrapNestedUpstreamError,
  wrapResponseToCaptureUpstreamRequestId,
} from './upstream-request-id.js';
export type { HeaderGetter, NestedUpstreamError } from './upstream-request-id.js';

export {
  llmPromptDebugEnabled,
  maybeLogLlmRequest,
  sanitizeLlmRequestBodyForDebug,
} from './llm-prompt-debug.js';

export { classifyModelError, isUpstreamRetryableCategory, isTerminalModelErrorCategory } from './error-class.js';
export type { ModelErrorCategory, ModelErrorClassification } from './error-class.js';
