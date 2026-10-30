/**
 * In-process hub for phone / device-local tool agents.
 * Sibling of DesktopAgentHub — not an SSH client and not FactoryTransport.
 *
 * A phone agent calls `attach` while its local tools are reachable. Shell and
 * copy stay off unless the agent opts in (`shell: true` / `copy: true`);
 * read is the default slice for this knife.
 */

import { createAttachmentHub, type AttachmentHub } from './attachment-hub.js';
import type {
  RegisteredMachineCopyInput,
  RegisteredMachineOpResult,
  RegisteredMachineReadInput,
  RegisteredMachineShellInput
} from './types.js';

export interface DeviceLocalHandlers {
  read(input: RegisteredMachineReadInput): Promise<RegisteredMachineOpResult>;
  /** Only invoked when the attachment sets `shell: true`. */
  shell?(input: RegisteredMachineShellInput): Promise<RegisteredMachineOpResult>;
  /** Only invoked when the attachment sets `copy: true`. */
  copy?(input: RegisteredMachineCopyInput): Promise<RegisteredMachineOpResult>;
}

export interface DeviceLocalAttachmentOptions {
  /** Default false: phone shell is not the r5-1 slice. */
  shell?: boolean;
  /** Default false: phone copy is not the r5-1 slice. */
  copy?: boolean;
}

export interface DeviceLocalAttachment {
  machineId: string;
  attachedAt: number;
  handlers: DeviceLocalHandlers;
  shell: boolean;
  copy: boolean;
}

export interface DeviceLocalHub {
  attach(
    machineId: string,
    handlers: DeviceLocalHandlers,
    options?: DeviceLocalAttachmentOptions
  ): { detach(): void };
  detach(machineId: string): boolean;
  isAttached(machineId: string): boolean;
  get(machineId: string): DeviceLocalAttachment | undefined;
  listAttached(): string[];
}

export interface DeviceLocalHubOptions {
  now?: () => number;
}

interface StoredHandlers extends DeviceLocalHandlers {
  shellEnabled: boolean;
  copyEnabled: boolean;
}

export function createDeviceLocalHub(options: DeviceLocalHubOptions = {}): DeviceLocalHub {
  const inner: AttachmentHub<StoredHandlers> = createAttachmentHub(options);
  return {
    attach(machineId, handlers, attachmentOptions = {}) {
      const lease = inner.attach(machineId, {
        ...handlers,
        shellEnabled: attachmentOptions.shell === true,
        copyEnabled: attachmentOptions.copy === true
      });
      return lease;
    },
    detach(machineId) {
      return inner.detach(machineId);
    },
    isAttached(machineId) {
      return inner.isAttached(machineId);
    },
    get(machineId) {
      const row = inner.get(machineId);
      if (!row) return undefined;
      return {
        machineId: row.machineId,
        attachedAt: row.attachedAt,
        handlers: row.handlers,
        shell: row.handlers.shellEnabled,
        copy: row.handlers.copyEnabled
      };
    },
    listAttached() {
      return inner.listAttached();
    }
  };
}

/** Process-wide hub for phone / device-local agents (one per Node process). */
let sharedHub: DeviceLocalHub | undefined;

export function getSharedDeviceLocalHub(): DeviceLocalHub {
  if (!sharedHub) sharedHub = createDeviceLocalHub();
  return sharedHub;
}

/** Test-only: replace or clear the process-wide phone hub. */
export function setSharedDeviceLocalHubForTests(hub: DeviceLocalHub | undefined): void {
  sharedHub = hub;
}
