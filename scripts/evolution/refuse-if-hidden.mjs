/**
 * Process guard for shell entry points (cron example, pipeline, nightly, drain).
 * Exit 0 when Evolution may run. Exit 3 when the product switch is off (no job started).
 */
import { pathToFileURL } from 'node:url';
import { EVOLUTION_DISABLED_CODE, considerEvolutionSchedule } from '../../packages/core/src/evolution/surface.ts';

export function evolutionHiddenExitCode() {
  const decision = considerEvolutionSchedule({ reason: 'cli' });
  if (decision.started) return 0;
  console.error(`${EVOLUTION_DISABLED_CODE}: Evolution is hidden and will not run.`);
  return 3;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(evolutionHiddenExitCode());
}
