/**
 * In-process hub for personal desktop agents that keep a long connection.
 * Separate from Factory SSH and from createSshRegisteredMachineBackend.
 *
 * A desktop agent process (or daemon SSE adapter) calls `attach` when the
 * long connection is up, and `detach` on close. Tool RPCs (shell/read/copy)
 * dispatch to the attached handlers without spawning ssh.
 */

import { createAttachmentHub } from './attachment-hub.js';
import type {
  RegisteredMachineCopyInput,
  RegisteredMachineOpResult,
  RegisteredMachineReadInput,
  RegisteredMachineShellInput
} from './types.js';

export interface DesktopAgentHandlers {
  shell(input: RegisteredMachineShellInput): Promise<RegisteredMachineOpResult>;
  read(input: RegisteredMachineReadInput): Promise<RegisteredMachineOpResult>;
  copy(input: RegisteredMachineCopyInput): Promise<RegisteredMachineOpResult>;
}

export interface DesktopAgentAttachment {
  machineId: string;
  attachedAt: number;
  handlers: DesktopAgentHandlers;
}

export interface DesktopAgentHub {
  /** Register live handlers for a machineId. Replaces any prior attachment. */
  attach(machineId: string, handlers: DesktopAgentHandlers): { detach(): void };
  detach(machineId: string): boolean;
  isAttached(machineId: string): boolean;
  get(machineId: string): DesktopAgentAttachment | undefined;
  /** Snapshot of currently attached machine ids (for diagnostics). */
  listAttached(): string[];
}

export interface DesktopAgentHubOptions {
  now?: () => number;
}

export function createDesktopAgentHub(options: DesktopAgentHubOptions = {}): DesktopAgentHub {
  return createAttachmentHub<DesktopAgentHandlers>(options);
}

/** Process-wide hub for the daemon / desktop embed (one per Node process). */
let sharedHub: DesktopAgentHub | undefined;

export function getSharedDesktopAgentHub(): DesktopAgentHub {
  if (!sharedHub) sharedHub = createDesktopAgentHub();
  return sharedHub;
}

/** Test-only: replace or clear the process-wide hub. */
export function setSharedDesktopAgentHubForTests(hub: DesktopAgentHub | undefined): void {
  sharedHub = hub;
}
