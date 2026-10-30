/**
 * Transport-agnostic bridge from a long-lived personal-agent channel onto
 * DesktopAgentHub or DeviceLocalHub. The daemon HTTP/SSE routes supply `send`;
 * unit tests supply a fake sink. This module does not import node:http or Factory.
 *
 * Desktop sessions always offer shell, read, and copy. Phone sessions offer
 * read by default; shell and copy are registered only when the attachment
 * opts in, so DeviceLocalHub keeps the read-only gate.
 *
 * Wire shape (daemon routes mirror this):
 *   event "op"   data { requestId, kind: "shell"|"read"|"copy", input }
 *   reply body   { requestId, result: RegisteredMachineOpResult }
 *   event "bye"  data { machineId }   (session closed)
 */

import type { DesktopAgentHub } from './agent-hub.js';
import type { DeviceLocalHub } from './device-local-hub.js';
import type {
  RegisteredMachineCopyInput,
  RegisteredMachineOpResult,
  RegisteredMachineReadInput,
  RegisteredMachineShellInput
} from './types.js';

export type DesktopAgentOpKind = 'shell' | 'read' | 'copy';

export interface DesktopAgentOpEvent {
  requestId: string;
  kind: DesktopAgentOpKind;
  input: RegisteredMachineShellInput | RegisteredMachineReadInput | RegisteredMachineCopyInput;
}

export interface DesktopAgentReply {
  requestId: string;
  result: RegisteredMachineOpResult;
}

export type DesktopAgentSseSend = (event: string, data: unknown) => void;

export interface DesktopAgentHttpSseSessionOptions {
  hub: DesktopAgentHub;
  machineId: string;
  send: DesktopAgentSseSend;
  /** Override in tests. Default is a random id. */
  newRequestId?: () => string;
}

export interface DesktopAgentHttpSseSession {
  readonly machineId: string;
  /** Resolves a pending op. Returns false when requestId is unknown or the session is closed. */
  handleReply(reply: DesktopAgentReply): boolean;
  /** Rejects pending ops as machine_disconnected, then detaches this lease. Idempotent. */
  close(): void;
  readonly closed: boolean;
}

const DISCONNECTED_MESSAGE = 'Registered machine is not connected';

function disconnectedResult(): RegisteredMachineOpResult {
  return {
    ok: false,
    content: JSON.stringify({
      error: 'machine_disconnected',
      message: DISCONNECTED_MESSAGE
    })
  };
}

function defaultRequestId(): string {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function replyResult(reply: DesktopAgentReply, requestId: string): RegisteredMachineOpResult {
  const result = reply.result;
  if (!result || typeof result.ok !== 'boolean' || typeof result.content !== 'string') {
    return {
      ok: false,
      content: JSON.stringify({ error: 'invalid_reply', requestId })
    };
  }
  return result;
}

interface OpDispatcher {
  dispatch(
    kind: DesktopAgentOpKind,
    input: DesktopAgentOpEvent['input']
  ): Promise<RegisteredMachineOpResult>;
}

interface HttpSseChannel {
  attach(machineId: string, ops: OpDispatcher): { detach(): void };
}

function openHttpSseSession(
  machineIdRaw: string,
  send: DesktopAgentSseSend,
  channel: HttpSseChannel,
  newRequestId: () => string
): DesktopAgentHttpSseSession {
  const machineId = machineIdRaw.trim();
  if (!machineId) throw new Error('machineId required');
  const pending = new Map<
    string,
    { resolve: (result: RegisteredMachineOpResult) => void }
  >();
  let closed = false;

  function dispatch(
    kind: DesktopAgentOpKind,
    input: DesktopAgentOpEvent['input']
  ): Promise<RegisteredMachineOpResult> {
    if (closed) return Promise.resolve(disconnectedResult());
    const requestId = newRequestId();
    const result = new Promise<RegisteredMachineOpResult>((resolve) => {
      pending.set(requestId, { resolve });
    });
    send('op', { requestId, kind, input } satisfies DesktopAgentOpEvent);
    return result;
  }

  const lease = channel.attach(machineId, { dispatch });

  function failPending(): void {
    const waiting = [...pending.values()];
    pending.clear();
    const result = disconnectedResult();
    for (const entry of waiting) entry.resolve(result);
  }

  return {
    machineId,
    get closed() {
      return closed;
    },
    handleReply(reply) {
      if (closed) return false;
      const requestId = typeof reply?.requestId === 'string' ? reply.requestId : '';
      const entry = requestId ? pending.get(requestId) : undefined;
      if (!entry) return false;
      pending.delete(requestId);
      entry.resolve(replyResult(reply, requestId));
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      failPending();
      lease.detach();
    }
  };
}

export function createDesktopAgentHttpSseSession(
  options: DesktopAgentHttpSseSessionOptions
): DesktopAgentHttpSseSession {
  return openHttpSseSession(
    options.machineId,
    options.send,
    {
      attach(machineId, ops) {
        return options.hub.attach(machineId, {
          shell: (input) => ops.dispatch('shell', input),
          read: (input) => ops.dispatch('read', input),
          copy: (input) => ops.dispatch('copy', input)
        });
      }
    },
    options.newRequestId ?? defaultRequestId
  );
}

export interface DeviceLocalHttpSseSessionOptions {
  hub: DeviceLocalHub;
  machineId: string;
  send: DesktopAgentSseSend;
  /** Default false: phone shell is not delivered unless the attachment opts in. */
  shell?: boolean;
  /** Default false: phone copy is not delivered unless the attachment opts in. */
  copy?: boolean;
  /** Override in tests. Default is a random id. */
  newRequestId?: () => string;
}

export function createDeviceLocalHttpSseSession(
  options: DeviceLocalHttpSseSessionOptions
): DesktopAgentHttpSseSession {
  const shell = options.shell === true;
  const copy = options.copy === true;
  return openHttpSseSession(
    options.machineId,
    options.send,
    {
      attach(machineId, ops) {
        return options.hub.attach(
          machineId,
          {
            read: (input) => ops.dispatch('read', input),
            ...(shell ? { shell: (input: RegisteredMachineShellInput) => ops.dispatch('shell', input) } : {}),
            ...(copy ? { copy: (input: RegisteredMachineCopyInput) => ops.dispatch('copy', input) } : {})
          },
          { shell, copy }
        );
      }
    },
    options.newRequestId ?? defaultRequestId
  );
}
