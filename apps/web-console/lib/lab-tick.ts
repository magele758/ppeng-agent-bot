export interface LabTickSteps {
  refreshMeta: () => Promise<void>;
  refreshOverview: () => Promise<void>;
  /** Omit to leave the open conversation alone on this tick. */
  refreshPlayPanel?: () => Promise<void>;
}

/** One console refresh. Version/health and the overview lists load side by side. */
export async function runLabTick(steps: LabTickSteps): Promise<void> {
  await Promise.all([steps.refreshMeta(), steps.refreshOverview()]);
  await steps.refreshPlayPanel?.();
}
