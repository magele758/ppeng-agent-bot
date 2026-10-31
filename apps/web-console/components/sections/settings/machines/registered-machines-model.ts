/** Pure helpers for the Lab registered machines panel (list / register / unregister / refresh). */

export interface RegisteredMachineSummary {
  machineId: string;
  label: string;
  kind: 'desktop' | 'phone' | 'other';
  connected: boolean;
  sshAlias?: string;
  deviceLocalTools?: { tool: string }[];
}

export function parseMachineList(data: unknown): RegisteredMachineSummary[] {
  if (!data || typeof data !== 'object') return [];
  const machines = (data as { machines?: unknown }).machines;
  if (!Array.isArray(machines)) return [];
  const out: RegisteredMachineSummary[] = [];
  for (const row of machines) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.machineId !== 'string' || typeof r.label !== 'string') continue;
    if (typeof r.kind !== 'string') continue;
    out.push({
      machineId: r.machineId,
      label: r.label,
      kind: r.kind as 'desktop' | 'phone' | 'other',
      connected: typeof r.connected === 'boolean' ? r.connected : false,
      sshAlias: typeof r.sshAlias === 'string' ? r.sshAlias : undefined,
      deviceLocalTools: Array.isArray(r.deviceLocalTools) ? r.deviceLocalTools as { tool: string }[] : undefined
    });
  }
  return out;
}

export function parseMachine(data: unknown): RegisteredMachineSummary | null {
  if (!data || typeof data !== 'object') return null;
  const machine = (data as { machine?: unknown }).machine;
  if (!machine || typeof machine !== 'object') return null;
  const r = machine as Record<string, unknown>;
  if (typeof r.machineId !== 'string' || typeof r.label !== 'string') return null;
  if (typeof r.kind !== 'string') return null;
  return {
    machineId: r.machineId,
    label: r.label,
    kind: r.kind as 'desktop' | 'phone' | 'other',
    connected: typeof r.connected === 'boolean' ? r.connected : false,
    sshAlias: typeof r.sshAlias === 'string' ? r.sshAlias : undefined,
    deviceLocalTools: Array.isArray(r.deviceLocalTools) ? r.deviceLocalTools as { tool: string }[] : undefined
  };
}

export function applyRegister(machines: RegisteredMachineSummary[], machine: RegisteredMachineSummary): RegisteredMachineSummary[] {
  return [...machines.filter(m => m.machineId !== machine.machineId), machine];
}

export function applyUnregister(machines: RegisteredMachineSummary[], machineId: string): RegisteredMachineSummary[] {
  return machines.filter(m => m.machineId !== machineId);
}

export function applyRefresh(machines: RegisteredMachineSummary[], machine: RegisteredMachineSummary): RegisteredMachineSummary[] {
  return machines.map(m => m.machineId === machine.machineId ? machine : m);
}
