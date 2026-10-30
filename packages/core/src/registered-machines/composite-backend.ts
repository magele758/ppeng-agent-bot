/**
 * Prefer a live personal-agent long connection; fall back to SSH Host alias.
 * Phone/device-local attachments are checked before desktop agents, then SSH.
 * Factory SSH remains a separate rail and is never consulted here.
 */

import {
  createDesktopAgentBackend,
  type DesktopAgentBackendOptions
} from './agent-backend.js';
import type { DesktopAgentHub } from './agent-hub.js';
import { createDeviceLocalBackend } from './device-local-backend.js';
import type { DeviceLocalHub } from './device-local-hub.js';
import {
  createSshRegisteredMachineBackend,
  type SshRegisteredMachineBackendOptions
} from './ssh-backend.js';
import type {
  RegisteredMachine,
  RegisteredMachineBackend,
  RegisteredMachineCopyInput,
  RegisteredMachineOpResult,
  RegisteredMachineReadInput,
  RegisteredMachineShellInput
} from './types.js';

export interface CompositeRegisteredMachineBackendOptions {
  /** Required for the non-SSH desktop long-connect path. */
  agentHub: DesktopAgentHub;
  /** Phone / device-local tools. When omitted, that path stays disconnected. */
  deviceLocalHub?: DeviceLocalHub;
  ssh?: SshRegisteredMachineBackendOptions;
  /** Inject backends in tests. */
  agentBackend?: RegisteredMachineBackend;
  deviceLocalBackend?: RegisteredMachineBackend;
  sshBackend?: RegisteredMachineBackend;
}

export function createCompositeRegisteredMachineBackend(
  options: CompositeRegisteredMachineBackendOptions
): RegisteredMachineBackend {
  const agent =
    options.agentBackend ??
    createDesktopAgentBackend({ hub: options.agentHub } satisfies DesktopAgentBackendOptions);
  const deviceLocal = options.deviceLocalHub
    ? (options.deviceLocalBackend ?? createDeviceLocalBackend({ hub: options.deviceLocalHub }))
    : undefined;
  const ssh = options.sshBackend ?? createSshRegisteredMachineBackend(options.ssh);

  function preferDeviceLocal(machine: RegisteredMachine): boolean {
    return options.deviceLocalHub?.isAttached(machine.machineId) === true && deviceLocal !== undefined;
  }

  function preferAgent(machine: RegisteredMachine): boolean {
    return options.agentHub.isAttached(machine.machineId);
  }

  return {
    isConnected(machineId, machine) {
      if (options.deviceLocalHub?.isAttached(machineId)) return true;
      if (options.agentHub.isAttached(machineId)) return true;
      return ssh.isConnected(machineId, machine);
    },
    async probe(machine) {
      if (preferDeviceLocal(machine) || preferAgent(machine)) return true;
      if (ssh.probe) return ssh.probe(machine);
      return ssh.isConnected(machine.machineId, machine);
    },
    async shell(machine, input: RegisteredMachineShellInput): Promise<RegisteredMachineOpResult> {
      if (preferDeviceLocal(machine)) return deviceLocal!.shell(machine, input);
      if (preferAgent(machine)) return agent.shell(machine, input);
      return ssh.shell(machine, input);
    },
    async read(machine, input: RegisteredMachineReadInput): Promise<RegisteredMachineOpResult> {
      if (preferDeviceLocal(machine)) return deviceLocal!.read(machine, input);
      if (preferAgent(machine)) return agent.read(machine, input);
      return ssh.read(machine, input);
    },
    async copy(machine, input: RegisteredMachineCopyInput): Promise<RegisteredMachineOpResult> {
      if (preferDeviceLocal(machine)) return deviceLocal!.copy(machine, input);
      if (preferAgent(machine)) return agent.copy(machine, input);
      return ssh.copy(machine, input);
    }
  };
}
