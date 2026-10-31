import type { ToolContract, ToolExecutionResult } from '../types.js';
import { AppError, AuthorizationError, NotFoundError, ValidationError } from '../errors.js';
import { principalFromSession } from '../bots/bot-identity.js';
import { commandHardlineToolResult } from '../sandbox/command-hardline.js';
import { resolveWorkspacePath } from '../workspace/resolve.js';
import type { SqliteStateStore } from '../storage.js';
import {
  assertRegisteredMachineId,
  type RegisteredMachinePort
} from './port.js';
import type { RegisteredMachineKind } from './types.js';

function failed(error: unknown): ToolExecutionResult {
  if (error instanceof AuthorizationError) {
    return { ok: false, content: JSON.stringify({ error: 'forbidden', message: error.message }) };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof AppError ? error.code : 'ERROR';
  return { ok: false, content: JSON.stringify({ error: code, message }) };
}

/**
 * Assistant-facing tools for personal registered machines.
 * Intentionally separate from `createFactoryTools` / factory_* names.
 */
export function createRegisteredMachineTools(
  store: SqliteStateStore,
  port: RegisteredMachinePort
): ToolContract<any>[] {
  return [
    {
      name: 'list_machines',
      description:
        'List this user\'s personal registered machines (desktop/phone). Returns machineId, label, kind (including phone), sshAlias, live connected status (desktop-agent long-connect, phone device-local attach, or SSH probe), and deviceLocalTools. Not the Factory SSH software-factory machine list — use factory_status for that.',
      approvalMode: 'never',
      sideEffectLevel: 'none',
      inputSchema: { type: 'object', properties: {} },
      async execute(ctx) {
        try {
          const principal = principalFromSession(store, ctx.session);
          const machines = await port.listLive(principal);
          return { ok: true, content: JSON.stringify({ machines }) };
        } catch (error) {
          return failed(error);
        }
      }
    },
    {
      name: 'register_machine',
      description:
        'Register or update a personal machine for this user (desktop/phone/other). kind=phone plus deviceLocalTools lists phone-class machines. Pass sshAlias (a Host alias from the user\'s own ~/.ssh/config, key-based auth, host key already trusted) to make the machine reachable for bash/read_file/copy_* via machineId; registering with sshAlias needs approval. Without sshAlias the machine stays disconnected until a desktop agent attaches (DesktopAgentHub) or a phone device-local agent attaches (DeviceLocalHub; read is the default slice). Does not touch Factory SSH settings.',
      approvalMode: 'auto',
      sideEffectLevel: 'none',
      needsApproval: (_ctx, args) => Boolean(args?.sshAlias),
      inputSchema: {
        type: 'object',
        properties: {
          machineId: { type: 'string' },
          label: { type: 'string' },
          kind: { type: 'string', enum: ['desktop', 'phone', 'other'] },
          sshAlias: { type: 'string', description: 'ssh Host alias from ~/.ssh/config (not user@host, not a Factory machine).' },
          deviceLocalTools: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                toolId: { type: 'string' },
                state: {
                  type: 'string',
                  enum: ['available', 'needs_permission', 'unavailable']
                }
              },
              required: ['toolId', 'state']
            }
          }
        },
        required: ['machineId', 'label', 'kind']
      },
      async execute(ctx, args) {
        try {
          const principal = principalFromSession(store, ctx.session);
          const machine = port.register(principal, {
            machineId: assertRegisteredMachineId(args.machineId),
            label: String(args.label ?? ''),
            kind: args.kind as RegisteredMachineKind,
            ...(args.sshAlias !== undefined ? { sshAlias: args.sshAlias } : {}),
            ...(args.deviceLocalTools !== undefined
              ? { deviceLocalTools: args.deviceLocalTools }
              : {})
          });
          const live = await port.refresh(principal, machine.machineId);
          return { ok: true, content: JSON.stringify({ machine: live }) };
        } catch (error) {
          return failed(error);
        }
      }
    },
    {
      name: 'unregister_machine',
      description:
        'Unregister a personal registered machine for this user. Requires machineId from list_machines. Does not touch Factory SSH.',
      approvalMode: 'auto',
      sideEffectLevel: 'none',
      needsApproval: () => true,
      inputSchema: {
        type: 'object',
        properties: {
          machineId: { type: 'string' }
        },
        required: ['machineId']
      },
      async execute(ctx, args) {
        try {
          const principal = principalFromSession(store, ctx.session);
          const machineId = assertRegisteredMachineId(args.machineId);
          const ok = port.unregister(principal, machineId);
          if (!ok) {
            return { ok: false, content: JSON.stringify({ error: 'machine_not_found', id: machineId }) };
          }
          return { ok: true, content: JSON.stringify({ ok: true, id: machineId }) };
        } catch (error) {
          return failed(error);
        }
      }
    },
    {
      name: 'copy_to_machine',
      description:
        'Copy a local workspace file to a personal registered machine. Requires machineId from list_machines. Never uses Factory SSH.',
      approvalMode: 'auto',
      sideEffectLevel: 'workspace',
      needsApproval: () => true,
      inputSchema: {
        type: 'object',
        properties: {
          machineId: { type: 'string' },
          localPath: { type: 'string' },
          remotePath: { type: 'string' }
        },
        required: ['machineId', 'localPath', 'remotePath']
      },
      async execute(ctx, args) {
        try {
          const principal = principalFromSession(store, ctx.session);
          const machineId = assertRegisteredMachineId(args.machineId);
          const result = await port.copy(principal, machineId, {
            direction: 'to',
            localPath: resolveWorkspacePath(ctx, String(args.localPath ?? '')),
            remotePath: String(args.remotePath ?? '')
          });
          return { ok: result.ok, content: result.content };
        } catch (error) {
          return failed(error);
        }
      }
    },
    {
      name: 'copy_from_machine',
      description:
        'Copy a file from a personal registered machine into the local workspace. Requires machineId from list_machines. Never uses Factory SSH.',
      approvalMode: 'auto',
      needsApproval: () => true,
      sideEffectLevel: 'workspace',
      inputSchema: {
        type: 'object',
        properties: {
          machineId: { type: 'string' },
          remotePath: { type: 'string' },
          localPath: { type: 'string' }
        },
        required: ['machineId', 'remotePath', 'localPath']
      },
      async execute(ctx, args) {
        try {
          const principal = principalFromSession(store, ctx.session);
          const machineId = assertRegisteredMachineId(args.machineId);
          const result = await port.copy(principal, machineId, {
            direction: 'from',
            localPath: resolveWorkspacePath(ctx, String(args.localPath ?? '')),
            remotePath: String(args.remotePath ?? '')
          });
          return { ok: result.ok, content: result.content };
        } catch (error) {
          return failed(error);
        }
      }
    }
  ];
}

/** Route bash/read_file when machineId is set. Returns null when machineId absent (local path). */
export async function executeOnRegisteredMachine(
  store: SqliteStateStore | undefined,
  port: RegisteredMachinePort | undefined,
  session: { metadata?: Record<string, unknown> },
  machineId: unknown,
  op: 'shell' | 'read',
  input: Record<string, unknown>
): Promise<ToolExecutionResult | null> {
  if (machineId === undefined || machineId === null || machineId === '') return null;
  if (!store || !port) {
    return {
      ok: false,
      content: JSON.stringify({
        error: 'registered_machines_unavailable',
        message: 'RegisteredMachinePort is not configured'
      })
    };
  }
  try {
    const id = assertRegisteredMachineId(machineId);
    const principal = principalFromSession(store, session as any);
    if (op === 'shell') {
      const denied = commandHardlineToolResult(String(input.command ?? ''));
      if (denied) return denied;
      const result = await port.shell(principal, id, {
        command: String(input.command ?? ''),
        ...(typeof input.timeout_ms === 'number' ? { timeoutMs: input.timeout_ms } : {})
      });
      return { ok: result.ok, content: result.content };
    }
    const result = await port.read(principal, id, {
      path: String(input.path ?? ''),
      ...(typeof input.offset_line === 'number' ? { offsetLine: input.offset_line } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {})
    });
    return { ok: result.ok, content: result.content };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return {
        ok: false,
        content: JSON.stringify({
          error: 'unknown_machine',
          message: error.message,
          hint: 'Call list_machines; do not pass a Factory machine id here'
        })
      };
    }
    return failed(error);
  }
}
