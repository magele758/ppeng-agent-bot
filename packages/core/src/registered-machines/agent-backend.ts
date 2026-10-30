/**
 * RegisteredMachineBackend backed by a long-lived desktop agent attachment.
 * Never imports FactoryTransport / factory settings.
 */

import { posix } from 'node:path';
import { pathHasSensitiveSecretName, sensitiveReadRefusal, SENSITIVE_READ_REFUSAL } from '../workspace/sensitive-read.js';
import type { DesktopAgentHub } from './agent-hub.js';
import type {
  RegisteredMachine,
  RegisteredMachineBackend,
  RegisteredMachineCopyInput,
  RegisteredMachineOpResult,
  RegisteredMachineReadInput,
  RegisteredMachineShellInput
} from './types.js';

const SENSITIVE_REMOTE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);
const MAX_COMMAND_BYTES = 64 * 1024;

function json(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function fail(
  error: string,
  machine: RegisteredMachine,
  message: string,
  extra?: Record<string, unknown>
): RegisteredMachineOpResult {
  return { ok: false, content: json({ error, machineId: machine.machineId, message, ...extra }) };
}

function disconnected(machine: RegisteredMachine): RegisteredMachineOpResult {
  return fail('machine_disconnected', machine, 'Registered machine is not connected');
}

function remoteRefusal(path: string): string | undefined {
  if (path.includes('\0') || path.length > 4096) return 'Invalid remote path';
  const normalized = posix.normalize(path);
  if (pathHasSensitiveSecretName(normalized)) return SENSITIVE_READ_REFUSAL;
  if (normalized.split('/').some((segment) => SENSITIVE_REMOTE_DIRS.has(segment))) {
    return SENSITIVE_READ_REFUSAL;
  }
  return undefined;
}

export interface DesktopAgentBackendOptions {
  hub: DesktopAgentHub;
}

export function createDesktopAgentBackend(
  options: DesktopAgentBackendOptions
): RegisteredMachineBackend {
  const { hub } = options;

  return {
    isConnected(machineId) {
      return hub.isAttached(machineId);
    },
    async probe(machine) {
      return hub.isAttached(machine.machineId);
    },
    async shell(machine, input: RegisteredMachineShellInput) {
      const attachment = hub.get(machine.machineId);
      if (!attachment) return disconnected(machine);
      if (Buffer.byteLength(input.command) > MAX_COMMAND_BYTES || input.command.includes('\0')) {
        return fail('invalid_command', machine, 'Command too large or contains NUL');
      }
      if (input.cwd?.includes('\0')) return fail('invalid_command', machine, 'Invalid cwd');
      return attachment.handlers.shell(input);
    },
    async read(machine, input: RegisteredMachineReadInput) {
      const attachment = hub.get(machine.machineId);
      if (!attachment) return disconnected(machine);
      const refused = remoteRefusal(input.path);
      if (refused) return fail('refused_path', machine, refused);
      return attachment.handlers.read(input);
    },
    async copy(machine, input: RegisteredMachineCopyInput) {
      const attachment = hub.get(machine.machineId);
      if (!attachment) return disconnected(machine);
      if (sensitiveReadRefusal(input.localPath)) {
        return fail('refused_path', machine, SENSITIVE_READ_REFUSAL);
      }
      const refused = remoteRefusal(input.remotePath);
      if (refused) return fail('refused_path', machine, refused);
      return attachment.handlers.copy(input);
    }
  };
}
