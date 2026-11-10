export interface LabTickSteps {
  refreshMeta: () => Promise<void>;
  /** Version and health rarely change; when this says no they are left for a later tick. */
  metaDue?: () => boolean;
  refreshOverview: () => Promise<void>;
  /** Omit to leave the open conversation alone on this tick. */
  refreshPlayPanel?: () => Promise<void>;
}

/** One console refresh. Version/health and the overview lists load side by side. */
export async function runLabTick(steps: LabTickSteps): Promise<void> {
  const meta = steps.metaDue?.() === false ? undefined : steps.refreshMeta();
  await Promise.all([meta, steps.refreshOverview()]);
  await steps.refreshPlayPanel?.();
}
