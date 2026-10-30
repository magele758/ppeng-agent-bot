/**
 * Shared in-process attachment map for personal-machine long connects.
 * Desktop agents and phone/device-local agents both use this; neither path
 * imports FactoryTransport or factory.* keys.
 */

export interface AttachmentHub<THandlers> {
  /** Register live handlers for a machineId. Replaces any prior attachment. */
  attach(machineId: string, handlers: THandlers): { detach(): void };
  detach(machineId: string): boolean;
  isAttached(machineId: string): boolean;
  get(machineId: string): { machineId: string; attachedAt: number; handlers: THandlers } | undefined;
  /** Snapshot of currently attached machine ids (for diagnostics). */
  listAttached(): string[];
}

export function createAttachmentHub<THandlers>(
  options: { now?: () => number } = {}
): AttachmentHub<THandlers> {
  const now = options.now ?? Date.now;
  const attached = new Map<
    string,
    { machineId: string; attachedAt: number; handlers: THandlers }
  >();

  return {
    attach(machineId, handlers) {
      const id = machineId.trim();
      if (!id) throw new Error('machineId required');
      const entry = { machineId: id, attachedAt: now(), handlers };
      attached.set(id, entry);
      let live = true;
      return {
        detach() {
          if (!live) return;
          live = false;
          const current = attached.get(id);
          if (current === entry) attached.delete(id);
        }
      };
    },
    detach(machineId) {
      return attached.delete(machineId.trim());
    },
    isAttached(machineId) {
      return attached.has(machineId.trim());
    },
    get(machineId) {
      return attached.get(machineId.trim());
    },
    listAttached() {
      return [...attached.keys()];
    }
  };
}
