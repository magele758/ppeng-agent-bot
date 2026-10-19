import { createHash } from "node:crypto";
import { ValidationError } from "../errors.js";
import type { DeliveryPolicy, DeliveryRequest } from "./delivery-types.js";
const ref =
  /^(?![./])(?!.*(?:\.\.|@\{|[ ~^:?*\[\\]))[A-Za-z0-9_./-]{1,180}(?<![./])$/;
export function parseDeliveryPolicy(input: unknown): DeliveryPolicy {
  const p = input as DeliveryPolicy;
  if (
    !p ||
    typeof p.enabled !== "boolean" ||
    !Array.isArray(p.allowedUserIds) ||
    p.allowedUserIds.some((x) => typeof x !== "string" || !x) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository) ||
    typeof p.repositoryNodeId !== "string" ||
    !/^[-A-Za-z0-9_+/=]{1,200}$/.test(p.repositoryNodeId) ||
    typeof p.target !== "string" ||
    !ref.test(p.target) ||
    p.target.startsWith("factory/") ||
    typeof p.credentialRef !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(p.credentialRef)
  )
    throw new ValidationError(
      "Invalid delivery target, identity or credential reference",
    );
  validateOperations(p);
  validateRequiredChecks(p);
  validateLimits(p);
  validateConfigurationSources(p);
  validateMergeIdentity(p);
  const copy = structuredClone(p);
  delete (copy as any).revision;
  return {
    ...copy,
    revision: createHash("sha256").update(JSON.stringify(copy)).digest("hex"),
  };
}
function validateOperations(p: DeliveryPolicy) {
  if (
    !Array.isArray(p.operations) ||
    !p.operations.includes("push") ||
    !p.operations.includes("pr") ||
    p.operations.some((x) => !["push", "pr", "merge"].includes(x)) ||
    p.mergeMethod !== "squash"
  )
    throw new ValidationError(
      "Supported operations are task push, PR and squash merge",
    );
}
function validateRequiredChecks(p: DeliveryPolicy) {
  if (
    !Array.isArray(p.requiredChecks) ||
    !p.requiredChecks.length ||
    p.requiredChecks.some(
      (c) =>
        !c ||
        !Number.isSafeInteger(c.workflowId) ||
        c.workflowId < 1 ||
        !Number.isSafeInteger(c.appId) ||
        c.appId < 1 ||
        typeof c.job !== "string" ||
        !c.job.trim() ||
        c.job.length > 180,
    )
  )
    throw new ValidationError("Trusted required CI sources required");
}
function validateLimits(p: DeliveryPolicy) {
  if (
    !Number.isInteger(p.maxRetries) ||
    p.maxRetries < 0 ||
    p.maxRetries > 5 ||
    !Number.isInteger(p.deadlineMs) ||
    p.deadlineMs < 1000 ||
    p.deadlineMs > 86400000 ||
    typeof p.downstream?.confirmed !== "boolean" ||
    typeof p.downstream.deploys !== "boolean"
  )
    throw new ValidationError(
      "Bounded retry, deadline and downstream scope required",
    );
}
function validateMergeIdentity(p: DeliveryPolicy) {
  const m = p.mergeIdentity;
  if (m === undefined) return;
  if (
    !m ||
    typeof m !== "object" ||
    Object.keys(m).some(
      (k) =>
        !["appId", "installationId", "credentialRef", "rulesetId"].includes(k),
    )
  )
    throw new ValidationError("Exact separate merge identity required");
  if (
    ![m.appId, m.installationId, m.rulesetId].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    typeof m.credentialRef !== "string" ||
    !/^[-A-Za-z0-9_]{1,80}$/.test(m.credentialRef) ||
    m.credentialRef === p.credentialRef
  )
    throw new ValidationError(
      "Pinned App, installation, ruleset and separate credential reference required",
    );
}
function validateConfigurationSources(p: DeliveryPolicy) {
  const allowed = new Set([
    "enabled",
    "allowedUserIds",
    "repository",
    "repositoryNodeId",
    "target",
    "credentialRef",
    "operations",
    "requiredChecks",
    "mergeMethod",
    "maxRetries",
    "deadlineMs",
    "downstream",
    "revision",
    "workflowDigests",
    "ciVariablesDigest",
    "mergeIdentity",
  ]);
  if (Object.keys(p).some((k) => !allowed.has(k)))
    throw new ValidationError(
      "Unsupported delivery configuration; secrets must use credential references",
    );
  if (
    p.workflowDigests &&
    Object.entries(p.workflowDigests).some(
      ([path, digest]) =>
        !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(path) ||
        !/^[a-f0-9]{40}$/.test(digest),
    )
  )
    throw new ValidationError("Exact reviewed workflow blobs required");
  if (p.ciVariablesDigest && !/^[a-f0-9]{64}$/.test(p.ciVariablesDigest))
    throw new ValidationError("Exact CI variables digest required");
}
export function deliveryQueueKey(
  p: Pick<DeliveryPolicy, "repositoryNodeId" | "target">,
) {
  return JSON.stringify([p.repositoryNodeId, p.target]);
}
export function validateDeliveryRequest(r: Partial<DeliveryRequest>) {
  if (
    ![
      "preflight",
      "snapshot",
      "artifact",
      "sync-artifact",
      "push",
      "pr",
      "merge",
    ].includes(String(r.action))
  )
    throw new ValidationError("Fixed delivery operation required");
  if (
    ["push", "pr", "merge"].includes(String(r.action)) &&
    (!/^factory_[A-Za-z0-9_-]+$/.test(String(r.taskId)) ||
      r.branch !== "factory/" + r.taskId ||
      !/^[a-f0-9]{40}$/.test(String(r.sha)))
  )
    throw new ValidationError(
      "Exact authorized task branch and candidate required",
    );
  if ("argv" in r || "force" in r || "token" in r || "url" in r)
    throw new ValidationError("General publisher capability forbidden");
  return r;
}
export function trustedCi(
  p: DeliveryPolicy,
  sha: string,
  base: string,
  checks: any[],
) {
  const selected: any[] = [];
  for (const required of p.requiredChecks) {
    const rows = checks.filter(
      (c) =>
        c.workflowId === required.workflowId &&
        c.job === required.job &&
        c.appId === required.appId &&
        c.trusted === true &&
        c.sha === sha &&
        c.baseSha === base,
    );
    const run = Math.max(0, ...rows.map((c) => Number(c.runId) || 0));
    const latest = Math.max(
      0,
      ...rows
        .filter((c) => (Number(c.runId) || 0) === run)
        .map((c) => Number(c.attempt) || 0),
    );
    const current = rows.filter(
      (c) => (Number(c.runId) || 0) === run && c.attempt === latest,
    );
    if (!current.length) return { state: "waiting", checks: selected };
    selected.push(...current);
    if (
      current.some(
        (c) => c.status === "completed" && c.conclusion !== "success",
      )
    )
      return { state: "failed", checks: selected };
    if (current.some((c) => c.status !== "completed"))
      return { state: "waiting", checks: selected };
  }
  return { state: "passed", checks: selected };
}
export function verifyDeliveryPilot(v: any) {
  if (
    !Array.isArray(v.tasks) ||
    v.tasks.length < 2 ||
    new Set(v.tasks.map((t: any) => t.identity)).size < 2
  )
    throw Error("Two distinct real machines required");
  if (
    v.tasks.some(
      (t: any) =>
        !t.real ||
        !t.merged ||
        !t.candidate ||
        !t.mergeSha ||
        !t.sourceUnchanged,
    ) ||
    !v.tasks.some((t: any) => t.ciRepair) ||
    !v.tasks.some((t: any) => t.baseAdvanced)
  )
    throw Error(
      "Real merged, repaired and synchronized trial evidence required",
    );
  const r = v.recovery;
  if (
    !r?.real ||
    r.branches !== v.tasks.length ||
    r.prs !== v.tasks.length ||
    r.merges !== v.tasks.length ||
    r.duplicateEffects !== false ||
    r.queueLength !== 0 ||
    r.occupied !== r.live ||
    r.live !== 0
  )
    throw Error("Duplicate effects or inconsistent recovery");
  return v;
}
