import { envBool, envInt } from './env.js';
import { parseApprovalPolicyFromEnv, type ApprovalPolicy } from './approval/approval-policy.js';

/** Snapshot of frequently used RAW_AGENT_* settings (read once per runtime). */
export interface RuntimeEnvConfig {
  maxParallelToolCalls: number;
  maxTurnsPerRun: number;
  approvalPolicy: ApprovalPolicy | undefined;
  streamEnabled: boolean;
  externalAiTools: boolean;
  memoryBackend: string;
  refusalPreservation: boolean;
  modelMaxRetries: number;
}

export function loadRuntimeEnvConfig(env: NodeJS.ProcessEnv = process.env): RuntimeEnvConfig {
  return {
    maxParallelToolCalls: envInt(env, 'RAW_AGENT_MAX_PARALLEL_TOOLS', 8),
    maxTurnsPerRun: envInt(env, 'RAW_AGENT_MAX_TURNS', 0),
    approvalPolicy: parseApprovalPolicyFromEnv(env),
    streamEnabled: envBool(env, 'RAW_AGENT_STREAM', true),
    externalAiTools: envBool(env, 'RAW_AGENT_EXTERNAL_AI_TOOLS', false),
    memoryBackend: String(env.RAW_AGENT_MEMORY_BACKEND ?? 'agent').trim() || 'agent',
    refusalPreservation: envBool(env, 'RAW_AGENT_REFUSAL_PRESERVATION', true),
    modelMaxRetries: envInt(env, 'RAW_AGENT_MODEL_MAX_RETRIES', 2)
  };
}
