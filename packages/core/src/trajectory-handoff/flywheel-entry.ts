/**
 * Knife-4 flywheel composition entry switch and rollback modes.
 * Independent Swarm uses a separate switch in swarm-entry.ts.
 * Missing stored value means the approved flywheel entry is open.
 */
export const FLYWHEEL_HANDOFF_ENTRY_CONTROL_KEY = 'trajectory-handoff.flywheel-entry';

export type FlywheelRollbackMode = 'stop_new_admission' | 'cancel_in_flight';
export type FlywheelInFlightPolicy = 'controlled_finish' | 'cancel';

export function readFlywheelHandoffEntrySwitch(stored: unknown): {
  readonly enabled: boolean;
  readonly explicitOff: boolean;
  readonly inFlightPolicy: FlywheelInFlightPolicy;
} {
  const policy = inFlightPolicyOf(stored);
  if (stored == null) return { enabled: true, explicitOff: false, inFlightPolicy: policy };
  if (stored === true || stored === 'on') return { enabled: true, explicitOff: false, inFlightPolicy: policy };
  if (stored === false || stored === 'off' || stored === 'explicit_off') {
    return { enabled: false, explicitOff: true, inFlightPolicy: policy };
  }
  if (typeof stored === 'object' && !Array.isArray(stored)) {
    const record = stored as Record<string, unknown>;
    if (record.explicitOff === true || record.enabled === false || record.source === 'explicit_off') {
      return { enabled: false, explicitOff: true, inFlightPolicy: policy };
    }
    if (record.enabled === true) return { enabled: true, explicitOff: false, inFlightPolicy: policy };
  }
  return { enabled: false, explicitOff: true, inFlightPolicy: policy };
}

function inFlightPolicyOf(stored: unknown): FlywheelInFlightPolicy {
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const policy = (stored as Record<string, unknown>).inFlightPolicy;
    if (policy === 'cancel') return 'cancel';
  }
  return 'controlled_finish';
}

/** Persistable switch value for rollback. Always stops new flywheel admission. */
export function rollbackFlywheelEntry(mode: FlywheelRollbackMode): {
  readonly enabled: false;
  readonly explicitOff: true;
  readonly source: 'explicit_off';
  readonly inFlightPolicy: FlywheelInFlightPolicy;
  readonly rollbackMode: FlywheelRollbackMode;
} {
  return {
    enabled: false,
    explicitOff: true,
    source: 'explicit_off',
    inFlightPolicy: mode === 'cancel_in_flight' ? 'cancel' : 'controlled_finish',
    rollbackMode: mode,
  };
}

export function flywheelNewAdmissionAllowed(stored: unknown): boolean {
  return readFlywheelHandoffEntrySwitch(stored).enabled === true;
}

export function flywheelInFlightShouldCancel(stored: unknown): boolean {
  const decision = readFlywheelHandoffEntrySwitch(stored);
  return decision.enabled !== true && decision.inFlightPolicy === 'cancel';
}
