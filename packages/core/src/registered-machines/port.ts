import { ValidationError, NotFoundError, AuthorizationError } from '../errors.js';
import type { SqliteStateStore } from '../storage.js';
import {
  botPrincipalKey,
  type BotPrincipal
} from '../bots/bot-identity.js';
import {
  createDisconnectedBackend,
  type RegisteredMachine,
  type RegisteredMachineBackend,
  type RegisteredMachineCopyInput,
  type RegisteredMachineKind,
  type RegisteredMachineOpResult,
  type RegisteredMachineReadInput,
  type RegisteredMachineShellInput,
  type DeviceLocalTool
} from './types.js';

const KINDS = new Set<RegisteredMachineKind>(['desktop', 'phone', 'other']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const SSH_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

/**
 * Sole application-facing port for personal registered machines.
 *
 * Storage key prefix: `registered.machines:` — never `factory.settings:`.
 * Factory SSH machines and FactoryTransport are out of scope for this port.
 */
export interface RegisteredMachinePort {
  list(principal: BotPrincipal): RegisteredMachine[];
  register(
    principal: BotPrincipal,
    input: {
      machineId: string;
      label: string;
      kind: RegisteredMachineKind;
      sshAlias?: string;
      deviceLocalTools?: DeviceLocalTool[];
    }
  ): RegisteredMachine;
  /** Like `list`, but probes each machine so `connected` is live. */
  listLive(principal: BotPrincipal): Promise<RegisteredMachine[]>;
  /** Re-probe one registered machine (fails closed to connected=false). */
  refresh(principal: BotPrincipal, machineId: string): Promise<RegisteredMachine>;
  unregister(principal: BotPrincipal, machineId: string): boolean;
  get(principal: BotPrincipal, machineId: string): RegisteredMachine | undefined;
  shell(
    principal: BotPrincipal,
    machineId: string,
    input: RegisteredMachineShellInput
  ): Promise<RegisteredMachineOpResult>;
  read(
    principal: BotPrincipal,
    machineId: string,
    input: RegisteredMachineReadInput
  ): Promise<RegisteredMachineOpResult>;
  copy(
    principal: BotPrincipal,
    machineId: string,
    input: RegisteredMachineCopyInput
  ): Promise<RegisteredMachineOpResult>;
}

function settingsKey(principal: BotPrincipal): string {
  return 'registered.machines:' + botPrincipalKey(principal);
}

function assertNeverFactoryKey(key: string): void {
  if (key.startsWith('factory.')) {
    throw new Error('RegisteredMachinePort must not use factory.* daemon_control keys');
  }
}

function parseId(value: string): string {
  const id = value.trim();
  if (!ID.test(id)) throw new ValidationError('Invalid machineId');
  return id;
}

function parseKind(value: unknown): RegisteredMachineKind {
  if (typeof value !== 'string' || !KINDS.has(value as RegisteredMachineKind)) {
    throw new ValidationError('kind must be desktop|phone|other');
  }
  return value as RegisteredMachineKind;
}

function parseLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new ValidationError('Invalid label');
  }
  return value.trim();
}

function parseSshAlias(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !SSH_ALIAS.test(value.trim())) {
    throw new ValidationError('Invalid sshAlias');
  }
  return value.trim();
}

function parseDeviceTools(value: unknown): DeviceLocalTool[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) throw new ValidationError('Invalid deviceLocalTools');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new ValidationError('Invalid deviceLocalTool');
    const row = item as Record<string, unknown>;
    if (typeof row.toolId !== 'string' || !row.toolId.trim()) throw new ValidationError('Invalid toolId');
    const state = row.state;
    if (state !== 'available' && state !== 'needs_permission' && state !== 'unavailable') {
      throw new ValidationError('Invalid deviceLocalTool state');
    }
    return { toolId: row.toolId.trim(), state };
  });
}

interface StoredRegistry {
  machines: Array<{
    machineId: string;
    label: string;
    kind: RegisteredMachineKind;
    sshAlias?: string;
    deviceLocalTools?: DeviceLocalTool[];
  }>;
}

function readRegistry(store: SqliteStateStore, principal: BotPrincipal): StoredRegistry {
  const key = settingsKey(principal);
  assertNeverFactoryKey(key);
  const raw = store.getDaemonControl<StoredRegistry>(key);
  if (!raw || !Array.isArray(raw.machines)) return { machines: [] };
  return { machines: raw.machines.filter((m) => m && typeof m.machineId === 'string') };
}

function writeRegistry(store: SqliteStateStore, principal: BotPrincipal, registry: StoredRegistry): void {
  const key = settingsKey(principal);
  assertNeverFactoryKey(key);
  store.setDaemonControl(key, registry);
}

function hydrate(
  row: StoredRegistry['machines'][number],
  backend: RegisteredMachineBackend
): RegisteredMachine {
  return {
    machineId: row.machineId,
    label: row.label,
    kind: row.kind,
    connected: backend.isConnected(row.machineId, {
      machineId: row.machineId,
      label: row.label,
      kind: row.kind,
      connected: false,
      ...(row.sshAlias ? { sshAlias: row.sshAlias } : {})
    }),
    ...(row.sshAlias ? { sshAlias: row.sshAlias } : {}),
    ...(row.deviceLocalTools ? { deviceLocalTools: row.deviceLocalTools } : {})
  };
}

function disconnectedResult(machine: RegisteredMachine): RegisteredMachineOpResult {
  return {
    ok: false,
    content: JSON.stringify({
      error: 'machine_disconnected',
      machineId: machine.machineId,
      message: 'Registered machine is not connected'
    })
  };
}

async function probeLive(
  backend: RegisteredMachineBackend,
  machine: RegisteredMachine
): Promise<RegisteredMachine> {
  if (!backend.probe) return machine;
  let connected = false;
  try {
    connected = (await backend.probe(machine)) === true;
  } catch {
    connected = false;
  }
  return { ...machine, connected };
}

export function createRegisteredMachinePort(
  store: SqliteStateStore,
  backend: RegisteredMachineBackend = createDisconnectedBackend()
): RegisteredMachinePort {
  function requireOwned(principal: BotPrincipal, machineId: string): RegisteredMachine {
    const id = parseId(machineId);
    const reg = readRegistry(store, principal);
    const row = reg.machines.find((m) => m.machineId === id);
    if (!row) throw new NotFoundError('RegisteredMachine', id);
    return hydrate(row, backend);
  }

  return {
    list(principal) {
      return readRegistry(store, principal).machines.map((row) => hydrate(row, backend));
    },
    async listLive(principal) {
      const rows = readRegistry(store, principal).machines.map((row) => hydrate(row, backend));
      return Promise.all(rows.map((machine) => probeLive(backend, machine)));
    },
    async refresh(principal, machineId) {
      return probeLive(backend, requireOwned(principal, machineId));
    },
    register(principal, input) {
      const machineId = parseId(input.machineId);
      const label = parseLabel(input.label);
      const kind = parseKind(input.kind);
      const sshAlias = parseSshAlias(input.sshAlias);
      const deviceLocalTools = parseDeviceTools(input.deviceLocalTools);
      const reg = readRegistry(store, principal);
      const next = {
        machineId,
        label,
        kind,
        ...(sshAlias ? { sshAlias } : {}),
        ...(deviceLocalTools ? { deviceLocalTools } : {})
      };
      const idx = reg.machines.findIndex((m) => m.machineId === machineId);
      if (idx >= 0) reg.machines[idx] = next;
      else {
        if (reg.machines.length >= 50) throw new ValidationError('Too many registered machines');
        reg.machines.push(next);
      }
      writeRegistry(store, principal, reg);
      return hydrate(next, backend);
    },
    unregister(principal, machineId) {
      const id = parseId(machineId);
      const reg = readRegistry(store, principal);
      const before = reg.machines.length;
      reg.machines = reg.machines.filter((m) => m.machineId !== id);
      if (reg.machines.length === before) return false;
      writeRegistry(store, principal, reg);
      return true;
    },
    get(principal, machineId) {
      const id = parseId(machineId);
      const row = readRegistry(store, principal).machines.find((m) => m.machineId === id);
      return row ? hydrate(row, backend) : undefined;
    },
    async shell(principal, machineId, input) {
      if (typeof input?.command !== 'string' || !input.command.trim()) {
        throw new ValidationError('command required');
      }
      const machine = await probeLive(backend, requireOwned(principal, machineId));
      if (!machine.connected) return disconnectedResult(machine);
      return backend.shell(machine, {
        command: input.command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {})
      });
    },
    async read(principal, machineId, input) {
      if (typeof input?.path !== 'string' || !input.path.trim()) {
        throw new ValidationError('path required');
      }
      const machine = await probeLive(backend, requireOwned(principal, machineId));
      if (!machine.connected) return disconnectedResult(machine);
      return backend.read(machine, {
        path: input.path.trim(),
        ...(typeof input.offsetLine === 'number' ? { offsetLine: input.offsetLine } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {})
      });
    },
    async copy(principal, machineId, input) {
      if (input?.direction !== 'to' && input?.direction !== 'from') {
        throw new ValidationError('direction must be to|from');
      }
      if (typeof input.localPath !== 'string' || !input.localPath.trim()) {
        throw new ValidationError('localPath required');
      }
      if (typeof input.remotePath !== 'string' || !input.remotePath.trim()) {
        throw new ValidationError('remotePath required');
      }
      const machine = await probeLive(backend, requireOwned(principal, machineId));
      if (!machine.connected) return disconnectedResult(machine);
      return backend.copy(machine, {
        direction: input.direction,
        localPath: input.localPath.trim(),
        remotePath: input.remotePath.trim()
      });
    }
  };
}

/** Guard used by tools: machineId routes only through this port, never Factory. */
export function assertRegisteredMachineId(machineId: unknown): string {
  if (typeof machineId !== 'string' || !machineId.trim()) {
    throw new ValidationError('machineId required');
  }
  return parseId(machineId);
}

export function denyCrossRailFactoryUse(): never {
  throw new AuthorizationError(
    'Registered personal machines must not use Factory SSH; use RegisteredMachinePort'
  );
}
