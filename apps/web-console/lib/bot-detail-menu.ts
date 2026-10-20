export type RoutineToggle = { id: string; enabled: boolean };

const SECRET_TEXT =
  /(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+\S+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gi;

const SECRET_KEY = /token|secret|password|api[_-]?key|credential|bearer/i;

export function presentMemoryValue(key: string, value: string, hidden: string): string {
  if (SECRET_KEY.test(key)) return hidden;
  const cleaned = redactMemoryStructure(value, hidden);
  if (cleaned.length <= 240) return cleaned;
  return `${cleaned.slice(0, 240)}…`;
}

export function redactSensitiveText(value: string, hidden: string): string {
  return value.replace(SECRET_TEXT, hidden);
}

/**
 * Apply a routine on/off only after the save reports that exact state.
 * A thrown save or a response that kept the old flag leaves the previous list.
 */
export async function commitRoutineEnabled<T extends RoutineToggle>(
  jobs: readonly T[],
  id: string,
  enabled: boolean,
  persist: (id: string, enabled: boolean) => Promise<{ enabled: boolean }>
): Promise<{ jobs: T[]; applied: boolean }> {
  const current = jobs.find((job) => job.id === id);
  if (!current) return { jobs: [...jobs], applied: false };
  try {
    const saved = await persist(id, enabled);
    if (typeof saved?.enabled !== 'boolean' || saved.enabled !== enabled) return { jobs: [...jobs], applied: false };
    return {
      jobs: jobs.map((job) => (job.id === id ? { ...job, enabled: saved.enabled } : job)),
      applied: true
    };
  } catch {
    return { jobs: [...jobs], applied: false };
  }
}

/** Drop a routine only after delete succeeds. A thrown delete leaves the previous list. */
export async function commitRoutineRemoved<T extends { id: string }>(
  jobs: readonly T[],
  id: string,
  persist: (id: string) => Promise<unknown>
): Promise<{ jobs: T[]; applied: boolean }> {
  if (!jobs.some((job) => job.id === id)) return { jobs: [...jobs], applied: false };
  try {
    await persist(id);
    return { jobs: jobs.filter((job) => job.id !== id), applied: true };
  } catch {
    return { jobs: [...jobs], applied: false };
  }
}

/** Stored memory may be JSON; secret key names remain sensitive at every depth. */
function redactMemoryStructure(value: string, hidden: string): string {
  try {
    return JSON.stringify(JSON.parse(value), (key: string, item: unknown) => {
      if (SECRET_KEY.test(key)) return hidden;
      return typeof item === 'string' ? redactSensitiveText(item, hidden) : item;
    });
  } catch {
    return redactSensitiveText(value, hidden);
  }
}
