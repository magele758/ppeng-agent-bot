/**
 * RegisteredMachineBackend for phone / device-local tools.
 * Read is the default slice. Shell and copy require an explicit opt-in on the
 * attachment AND an `available` deviceLocalTool id. Never uses SSH or Factory.
 */

import { posix } from 'node:path';
import { pathHasSensitiveSecretName, SENSITIVE_READ_REFUSAL } from '../workspace/sensitive-read.js';
import type { DeviceLocalHub } from './device-local-hub.js';
import type {
  DeviceLocalTool,
  RegisteredMachine,
  RegisteredMachineBackend,
  RegisteredMachineCopyInput,
  RegisteredMachineOpResult,
  RegisteredMachineReadInput,
  RegisteredMachineShellInput
} from './types.js';

const SENSITIVE_REMOTE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);
const MAX_COMMAND_BYTES = 64 * 1024;

/** Registry ids that unlock the non-default slices when the attachment opts in. */
export const DEVICE_LOCAL_SHELL_TOOL_ID = 'device_shell';
export const DEVICE_LOCAL_COPY_TOOL_ID = 'device_copy';

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

function toolAvailable(machine: RegisteredMachine, toolId: string): boolean {
  const tools: DeviceLocalTool[] = machine.deviceLocalTools ?? [];
  return tools.some((tool) => tool.toolId === toolId && tool.state === 'available');
}

export interface DeviceLocalBackendOptions {
  hub: DeviceLocalHub;
}

export function createDeviceLocalBackend(
  options: DeviceLocalBackendOptions
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
      if (!attachment.shell || !attachment.handlers.shell) {
        return fail(
          'device_local_readonly',
          machine,
          'Phone device-local path is read-only; shell is not enabled on this attachment'
        );
      }
      if (!toolAvailable(machine, DEVICE_LOCAL_SHELL_TOOL_ID)) {
        return fail(
          'device_local_tool_unavailable',
          machine,
          `deviceLocalTools must list ${DEVICE_LOCAL_SHELL_TOOL_ID} as available`
        );
      }
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
      if (!attachment.copy || !attachment.handlers.copy) {
        return fail(
          'device_local_readonly',
          machine,
          'Phone device-local path is read-only; copy is not enabled on this attachment'
        );
      }
      if (!toolAvailable(machine, DEVICE_LOCAL_COPY_TOOL_ID)) {
        return fail(
          'device_local_tool_unavailable',
          machine,
          `deviceLocalTools must list ${DEVICE_LOCAL_COPY_TOOL_ID} as available`
        );
      }
      const refusedLocal = remoteRefusal(input.localPath);
      if (refusedLocal) return fail('refused_path', machine, refusedLocal);
      const refused = remoteRefusal(input.remotePath);
      if (refused) return fail('refused_path', machine, refused);
      return attachment.handlers.copy(input);
    }
  };
}
