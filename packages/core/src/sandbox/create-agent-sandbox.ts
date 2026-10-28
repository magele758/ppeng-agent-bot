import type { AgentSandbox, AgentSandboxKind } from './agent-sandbox-types.js';
import { NativeAgentSandbox } from './native-agent-sandbox.js';
import { RemoteVmAgentSandbox } from './remote-vm-agent-sandbox.js';
import { MicroserviceAgentSandbox } from './microservice-agent-sandbox.js';
import { getBoundSandboxSettingsStore, resolveSandboxMode } from './sandbox-settings.js';

const REMOTE_VM_KINDS = new Set(['remote_vm', 'remote-vm', 'e2b', 'microvm', 'agent-sandbox-microvm']);
const MICROSERVICE_KINDS = new Set(['microservice', 'runner', 'service']);

/**
 * High-level kind for *agent* execution (orthogonal to `RAW_AGENT_SANDBOX_MODE`
 * which only applies to {@link NativeAgentSandbox}).
 *
 * Env: `RAW_AGENT_AGENT_SANDBOX_KIND=native|remote_vm|microvm|microservice` (default: native).
 * `microvm` stays on the remote /exec path. It does not fall through to the host.
 */
export function agentSandboxKindFromEnv(env?: NodeJS.ProcessEnv): AgentSandboxKind {
  const e = env ?? process.env;
  const raw = (e.RAW_AGENT_AGENT_SANDBOX_KIND ?? 'native').trim().toLowerCase();
  if (REMOTE_VM_KINDS.has(raw)) return 'remote_vm';
  if (MICROSERVICE_KINDS.has(raw)) return 'microservice';
  return 'native';
}

export function createAgentSandboxFromEnv(env?: NodeJS.ProcessEnv): AgentSandbox {
  const e = env ?? process.env;
  const kind = agentSandboxKindFromEnv(e);
  if (kind === 'remote_vm') {
    return new RemoteVmAgentSandbox(e);
  }
  if (kind === 'microservice') {
    return new MicroserviceAgentSandbox(e);
  }
  return new NativeAgentSandbox(() => resolveSandboxMode(getBoundSandboxSettingsStore(), e));
}
