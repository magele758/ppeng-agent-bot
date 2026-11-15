/**
 * In-process host boundary registry.
 * A session metadata key is not isolation unless the host installed the registry.
 * This map does not decide handoff state and does not grant budget.
 */
import type { BoundaryRegistry } from './types.js';

const registries = new Map<string, BoundaryRegistry>();

export function hostBoundaryKey(runId: string, workerId: string): string {
  return `${runId}\0${workerId}`;
}

export function installHostBoundary(key: string, registry: BoundaryRegistry): void {
  registries.set(key, registry);
}

export function readHostBoundary(key: string): BoundaryRegistry | undefined {
  return registries.get(key);
}

export function clearHostBoundary(key: string): void {
  registries.delete(key);
}

export function clearHostBoundaries(): void {
  registries.clear();
}
