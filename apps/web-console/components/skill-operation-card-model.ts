export type SkillOperationCardStatus =
  | "pending"
  | "processing"
  | "saved"
  | "rejected"
  | "failed";

export type SkillOperationCardRow = {
  id: string;
  name: string;
  status: SkillOperationCardStatus;
  input: { action: string };
};

function lastMatch<T>(rows: readonly T[], pred: (row: T) => boolean): T | undefined {
  let found: T | undefined;
  for (const row of rows) if (pred(row)) found = row;
  return found;
}

/** One visible card per skill action and name. Rows must already be in creation order. */
export function visibleSkillOperationCards<T extends SkillOperationCardRow>(
  rows: readonly T[],
  dismissed: ReadonlySet<string>,
  confirming: ReadonlySet<string>,
): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.input.action}\0${row.name}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const keep = new Set<string>();
  for (const group of groups.values()) {
    const active = lastMatch(
      group,
      (row) =>
        !dismissed.has(row.id) &&
        (confirming.has(row.id) || row.status === "processing" || row.status === "saved"),
    );
    const settled = group.some(
      (row) => confirming.has(row.id) || row.status === "processing" || row.status === "saved",
    );
    if (settled) {
      if (active) keep.add(active.id);
      continue;
    }
    const failed = group.some((row) => row.status === "failed");
    if (failed) {
      const visible = lastMatch(group, (row) => row.status === "failed" && !dismissed.has(row.id));
      if (visible) keep.add(visible.id);
      continue;
    }
    const pending = lastMatch(group, (row) => row.status === "pending" && !dismissed.has(row.id));
    if (pending) {
      keep.add(pending.id);
      continue;
    }
    const rejected = lastMatch(group, (row) => row.status === "rejected" && !dismissed.has(row.id));
    if (rejected) keep.add(rejected.id);
  }
  return rows.filter((row) => keep.has(row.id));
}

export function skillOperationCardIsBar(
  row: SkillOperationCardRow,
  confirming: ReadonlySet<string>,
): boolean {
  return confirming.has(row.id) || row.status !== "pending";
}

export function skillOperationCardStatus(
  row: SkillOperationCardRow,
  confirming: ReadonlySet<string>,
): SkillOperationCardStatus {
  if (confirming.has(row.id) && row.status === "pending") return "processing";
  return row.status;
}
