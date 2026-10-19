export const REQUIRED_GATES = [
  "build",
  "unit",
  "integration",
  "browser",
  "faults",
  "migration-rollback",
  "performance",
  "soak",
  "live-model",
  "live-software",
  "acceptance",
  "crap",
];

/** Structural claim check only. Release authorization additionally requires verified artifact files. */
export function assessReleaseEvidence(manifest) {
  const checks = Array.isArray(manifest?.checks) ? manifest.checks : [];
  const missing = REQUIRED_GATES.filter(
    (gate) =>
      !checks.some((check) => {
        if (
          !manifest?.candidate ||
          check?.gate !== gate ||
          check.candidate !== manifest.candidate ||
          check.status !== "passed" ||
          typeof check.artifact !== "string" ||
          !check.artifact.trim()
        )
          return false;
        if (gate === "soak")
          return (
            check.durationSeconds >= 86400 &&
            check.warmupSeconds >= 1800 &&
            check.fullProtocol === true
          );
        if (gate === "performance")
          return (
            check.fullProtocol === true &&
            check.referenceHardwareMatched === true
          );
        if (gate === "faults")
          return (
            check.sequences >= 10000 &&
            check.consecutivePasses >= 3 &&
            check.killRestart === true
          );
        if (gate === "browser")
          return check.consecutivePasses >= 3 && check.retries === 0;
        if (gate === "live-model")
          return (
            check.trialsPerModel >= 3 &&
            check.criticalRecall === 1 &&
            check.otherRecall >= 0.95
          );
        return true;
      }),
  );
  return {
    candidate: manifest?.candidate ?? null,
    ready: missing.length === 0,
    missing,
    authoritative: false,
  };
}
