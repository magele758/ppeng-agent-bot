/**
 * Flywheel research/review phase permissions.
 * Reuses the adapter / tool-entry intersection; hostPhase research|review is read-only
 * even when the role is switched to executor.
 */
import { denyTrajectoryTool } from '@ppeng/agent-loop';

export type FlywheelReadonlyPhase = 'research' | 'review';
export type FlywheelPhaseRole = 'planner' | 'executor';

export function flywheelPhaseSessionMetadata(input: {
  readonly phase: FlywheelReadonlyPhase;
  readonly role: FlywheelPhaseRole;
}): Record<string, unknown> {
  const planner = input.role === 'planner';
  return {
    hostPhase: input.phase,
    handoffEnablement: { source: 'explicit_on' },
    capabilityTiers: { enablementSource: 'explicit_on', enabled: true },
    handoffState: planner ? 'planner_readonly' : 'executor_write',
    trajectoryHandoffExplicit: true,
  };
}

/** Returns a denial reason when the write must not proceed, otherwise undefined. */
export function denyFlywheelPhaseWrite(input: {
  readonly phase: FlywheelReadonlyPhase;
  readonly role: FlywheelPhaseRole;
  readonly tool?: { name: string; access?: string; sideEffectLevel?: string };
}): string | undefined {
  return denyTrajectoryTool(
    { metadata: flywheelPhaseSessionMetadata(input) },
    input.tool ?? { name: 'write_file', access: 'write', sideEffectLevel: 'write' },
  );
}

export function flywheelPhaseWriteDenied(input: {
  readonly phase: FlywheelReadonlyPhase;
  readonly role: FlywheelPhaseRole;
}): boolean {
  return denyFlywheelPhaseWrite(input) !== undefined;
}
