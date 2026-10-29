/** Personal registered machines — separate rail from Factory SSH (`factory.settings:*`). */

export type RegisteredMachineKind = 'desktop' | 'phone' | 'other';

export type DeviceLocalToolState = 'available' | 'needs_permission' | 'unavailable';

export interface DeviceLocalTool {
  toolId: string;
  state: DeviceLocalToolState;
}

export interface RegisteredMachine {
  machineId: string;
  label: string;
  kind: RegisteredMachineKind;
  connected: boolean;
  /** Host alias from the user's own ssh config. Required for the live SSH backend. */
  sshAlias?: string;
  /** Optional phone/desktop local tools (stretch; listing only). */
  deviceLocalTools?: DeviceLocalTool[];
}

export interface RegisteredMachineShellInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface RegisteredMachineReadInput {
  path: string;
  offsetLine?: number;
  limit?: number;
}

export interface RegisteredMachineCopyInput {
  direction: 'to' | 'from';
  localPath: string;
  remotePath: string;
}

export interface RegisteredMachineOpResult {
  ok: boolean;
  content: string;
  exitCode?: number;
}

/**
 * Pluggable backend for live connectivity and remote ops.
 * Must never be FactoryTransport / factory SSH.
 */
export interface RegisteredMachineBackend {
  /** Cached / best-effort state for sync listing. Use `probe` for a live answer. */
  isConnected(machineId: string, machine?: RegisteredMachine): boolean;
  /** Live reachability check. Must resolve false (never throw) when offline. */
  probe?(machine: RegisteredMachine): Promise<boolean>;
  shell(
    machine: RegisteredMachine,
    input: RegisteredMachineShellInput
  ): Promise<RegisteredMachineOpResult>;
  read(
    machine: RegisteredMachine,
    input: RegisteredMachineReadInput
  ): Promise<RegisteredMachineOpResult>;
  copy(
    machine: RegisteredMachine,
    input: RegisteredMachineCopyInput
  ): Promise<RegisteredMachineOpResult>;
}

/** Default backend: registry works; remote ops fail closed until a real backend is wired. */
export function createDisconnectedBackend(): RegisteredMachineBackend {
  return {
    isConnected() {
      return false;
    },
    async shell(machine) {
      return {
        ok: false,
        content: JSON.stringify({
          error: 'machine_disconnected',
          machineId: machine.machineId,
          message: 'Registered machine is not connected'
        })
      };
    },
    async read(machine) {
      return {
        ok: false,
        content: JSON.stringify({
          error: 'machine_disconnected',
          machineId: machine.machineId,
          message: 'Registered machine is not connected'
        })
      };
    },
    async copy(machine) {
      return {
        ok: false,
        content: JSON.stringify({
          error: 'machine_disconnected',
          machineId: machine.machineId,
          message: 'Registered machine is not connected'
        })
      };
    }
  };
}
