import { randomUUID, createHash } from "node:crypto";
import type { SqliteStateStore } from "../storage.js";
import { botPrincipalKey, type BotPrincipal } from "../bots/bot-identity.js";
import {
  AuthorizationError,
  ConflictError,
  ValidationError,
  NotFoundError,
} from "../errors.js";
import type { FactoryTask, FactoryTransport } from "./types.js";
import type {
  DeliveryHost,
  DeliveryPolicy,
  DeliveryRecord,
  DeliveryRequest,
} from "./delivery-types.js";
import {
  parseDeliveryPolicy,
  deliveryQueueKey,
  validateDeliveryRequest,
  trustedCi,
} from "./delivery-policy.js";
import {
  verifyReady,
  mergeDevelopmentIssueLedger,
} from "./development-evidence.js";
import { redactFactoryOutput } from "./redaction.js";
const controllerToken = randomUUID();
const runningControllers = new Set<string>();
/** Durable remote effects journal. A queue owner is released only after independent reconciliation.
 * No expiry is treated as proof that a writer has stopped. Host publisher provides the second fence. */
const stoppedDeliveryStages = new Set([
  "MERGED",
  "PR_READY",
  "DEFERRED",
  "WAITING_DECISION",
  "PAUSED",
  "CANCELLED",
]);
export class FactoryDelivery {
  private active = new Set<string>();
  constructor(
    private store: SqliteStateStore,
    private host: DeliveryHost,
    private transport: FactoryTransport,
    private clock: () => number = Date.now,
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS factory_delivery_archive(task_id TEXT NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(task_id,digest)); CREATE TABLE IF NOT EXISTS factory_delivery_controller(task_id TEXT PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL); CREATE TABLE IF NOT EXISTS factory_delivery(task_id TEXT PRIMARY KEY,principal TEXT NOT NULL,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS factory_delivery_queue(key TEXT PRIMARY KEY,task_id TEXT NOT NULL,operation TEXT NOT NULL);",
    );
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private key(p: BotPrincipal, m: string, r: string) {
    return "factory.delivery:" + botPrincipalKey(p) + ":" + m + ":" + r;
  }
  private target(p: BotPrincipal, m: string, r: string) {
    const machine = this.host.settings(p).machines.find((x) => x.id === m);
    if (!machine || !machine.repositories.some((x) => x.id === r))
      throw new NotFoundError("Factory project");
    if (!machine.allowedUserIds.includes(p.userId))
      throw new AuthorizationError("Factory project permission required");
    return machine;
  }
  settings(p: BotPrincipal, m: string, r: string): DeliveryPolicy {
    this.target(p, m, r);
    return (
      this.store.getDaemonControl<DeliveryPolicy>(this.key(p, m, r)) ??
      ({ enabled: false } as DeliveryPolicy)
    );
  }
  save(p: BotPrincipal, m: string, r: string, input: unknown) {
    this.target(p, m, r);
    const policy = parseDeliveryPolicy(input);
    this.store.setDaemonControl(this.key(p, m, r), policy);
    return policy;
  }
  private authorize(p: BotPrincipal, t: FactoryTask) {
    this.target(p, t.machineId, t.repositoryId);
    const policy = this.settings(p, t.machineId, t.repositoryId);
    if (!policy.enabled || !policy.allowedUserIds.includes(p.userId))
      throw new AuthorizationError("Explicit delivery authorization required");
    return policy;
  }
  current(p: BotPrincipal, id: string): DeliveryRecord | null {
    this.host.get(p, id);
    const row = this.store.db
      .prepare(
        "SELECT data FROM factory_delivery WHERE task_id=? AND principal=?",
      )
      .get(id, botPrincipalKey(p)) as { data: string } | undefined;
    if (!row) return null;
    const record = JSON.parse(row.data) as DeliveryRecord;
    // Legacy records could retain a transient reason after the verified merge fact.
    if (
      record.stage === "MERGED" &&
      record.mergeSha &&
      !record.evidenceRecoveryRequired
    )
      delete record.reason;
    return record;
  }
  private write(p: BotPrincipal, d: DeliveryRecord) {
    const saved = this.current(p, d.taskId);
    if (saved) {
      if ((saved.controlVersion ?? 0) > (d.controlVersion ?? 0)) {
        d.grants = structuredClone(saved.grants);
        d.decisions = structuredClone(saved.decisions);
        d.controlVersion = saved.controlVersion;
        if (d.stage !== "MERGED") d.stage = saved.stage;
      }
      if (saved.mergeSha) {
        d.stage = "MERGED";
        delete d.reason;
        d.mergeSha = saved.mergeSha;
        d.candidate = saved.candidate;
        d.pr = saved.pr;
      }
      const history = new Map(
        [...saved.history, ...d.history].map((e) => [JSON.stringify(e), e]),
      );
      d.history = [...history.values()];
    }
    if (d.evidenceRecoveryRequired && d.stage !== "MERGED")
      d.stage = d.pending ? "VERIFYING" : "DEFERRED";
    d.updatedAt = this.now();
    let safe = redactFactoryOutput(d);
    const full = JSON.stringify(safe),
      bytes = Buffer.byteLength(full);
    if (bytes > 524288) {
      const digest = createHash("sha256").update(full).digest("hex"),
        available = bytes <= 4194304;
      if (available)
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO factory_delivery_archive VALUES(?,?,?,?)",
          )
          .run(d.taskId, digest, bytes, full);
      d.evidenceRecoveryRequired = true;
      d.evidenceSnapshot = { digest, bytes, available };
      if (d.stage !== "MERGED") d.stage = d.pending ? "VERIFYING" : "DEFERRED";
      d.reason =
        "Delivery evidence exceeds view budget; full snapshot recovery required";
      d.ciHistory = d.ciHistory.slice(-1).map((h) => ({
        ...h,
        checks: h.checks.slice(0, 64).map((c) => ({
          id: c.id,
          workflowId: c.workflowId,
          job: String(c.job).slice(0, 180),
          sha: c.sha,
          baseSha: c.baseSha,
          attempt: c.attempt,
          status: c.status,
          conclusion: c.conclusion,
          evidenceTruncated: true,
        })),
      }));
      d.history = d.history.slice(-16).map((e) => ({
        ...e,
        detail: {
          summary: JSON.stringify(e.detail).slice(0, 1024),
          truncated: true,
          snapshot: digest,
        },
      }));
      safe = redactFactoryOutput(d);
    }
    this.store.db
      .prepare(
        "INSERT INTO factory_delivery VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data",
      )
      .run(d.taskId, botPrincipalKey(p), JSON.stringify(safe));
    this.host.deliveryNotice?.(this.host.get(p, d.taskId), safe);
  }
  evidence(p: BotPrincipal, id: string, digest: string, offset = 0) {
    this.host.get(p, id);
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new ValidationError("Exact snapshot and byte offset required");
    const row = this.store.db
      .prepare(
        "SELECT bytes,data FROM factory_delivery_archive WHERE task_id=? AND digest=?",
      )
      .get(id, digest) as { bytes: number; data: string } | undefined;
    if (!row) throw new NotFoundError("Delivery snapshot");
    const data = Buffer.from(row.data);
    if (offset > data.length)
      throw new ValidationError("Snapshot offset out of bounds");
    const page = data.subarray(offset, offset + 65536);
    return {
      digest,
      totalBytes: row.bytes,
      offset,
      nextOffset: offset + page.length,
      base64: page.toString("base64"),
      text: page.toString("utf8"),
    };
  }
  private event(d: DeliveryRecord, kind: string, detail: unknown) {
    if (
      d.history.at(-1)?.kind === kind &&
      JSON.stringify(d.history.at(-1)?.detail) ===
        JSON.stringify(redactFactoryOutput(detail))
    )
      return;
    d.history.push({
      kind,
      at: this.now(),
      detail: redactFactoryOutput(detail),
    });
  }
  private ready(t: FactoryTask) {
    if (
      !t.development ||
      t.development.stage !== "READY" ||
      t.status !== "succeeded"
    )
      throw new ConflictError("Valid development READY required");
    const current = this.host.development.current(t.principal, t.id);
    if (!current.evidenceCurrent || !t.identity)
      throw new ConflictError("READY policy or machine identity stale");
    const r = t.result?.development as any;
    verifyReady(t.development.policy, r);
    if (r.manifest.baseline !== t.development.baseline)
      throw new ConflictError("READY baseline mismatch");
    return r;
  }
  grant(p: BotPrincipal, id: string, input: any) {
    const task = this.host.get(p, id),
      policy = this.authorize(p, task);
    const result = this.ready(task);
    if (
      !["PR", "MERGED"].includes(input?.scope) ||
      (input.scope === "MERGED" && !policy.operations.includes("merge"))
    )
      throw new ValidationError("Allowed task delivery scope required");
    let d = this.current(p, id);
    if (
      d &&
      !d.grants.at(-1)?.revoked &&
      d.policy.revision === policy.revision &&
      d.grants.at(-1)?.scope === input.scope &&
      d.candidate === result.sha &&
      d.developmentRevision === task.development!.policy.revision
    )
      return d;
    if (d?.evidenceRecoveryRequired)
      throw new ConflictError("Full delivery evidence recovery required");
    if (d?.pending)
      throw new ConflictError(
        "Verify outstanding remote operation before new grant",
      );
    d ??= {
      taskId: id,
      stage: "QUEUED",
      policy: structuredClone(policy),
      candidate: result.sha,
      originalBase: task.development!.baseline,
      deliveryBase: result.deliveryBase ?? task.development!.baseline,
      branch: "factory/" + id,
      identity: task.identity!,
      generation: task.development!.generation,
      developmentRevision: task.development!.policy.revision,
      attempts: 0,
      grants: [],
      ciHistory: [],
      history: [],
      decisions: [],
      createdAt: this.now(),
      updatedAt: this.now(),
      deployment: "not_deployed",
    };
    d.candidate = result.sha;
    d.generation = task.development!.generation;
    d.developmentRevision = task.development!.policy.revision;
    d.deliveryBase = result.deliveryBase ?? task.development!.baseline;
    d.policy = structuredClone(policy);
    d.stage = "QUEUED";
    delete d.reason;
    d.controlVersion = (d.controlVersion ?? 0) + 1;
    d.grants.push({
      userId: p.userId,
      at: this.now(),
      scope: input.scope,
      policyRevision: policy.revision,
      repositoryNodeId: policy.repositoryNodeId,
      target: policy.target,
    });
    this.event(d, "grant", d.grants.at(-1));
    this.write(p, d);
    return d;
  }
  private async call(
    t: FactoryTask,
    d: DeliveryRecord,
    action: string,
    extra: Record<string, unknown> = {},
  ) {
    if (!this.transport.delivery) throw Error("Publisher unavailable");
    const request: DeliveryRequest = {
      action,
      taskId: t.id,
      policy: d.policy,
      baseSha: d.deliveryBase,
      baseline: d.originalBase,
      sha: d.candidate,
      branch: d.branch,
      generation: d.generation,
      identity: d.identity,
      sensitiveConfirmedSha: d.sensitiveConfirmedSha,
      pendingOperationId: d.pending?.id,
      ...extra,
    };
    validateDeliveryRequest(request);
    return this.transport.delivery(t.machine, request, t);
  }
  async preflight(p: BotPrincipal, m: string, r: string) {
    const machine = this.target(p, m, r),
      policy = this.settings(p, m, r);
    if (!policy.enabled || !policy.allowedUserIds.includes(p.userId))
      throw new AuthorizationError("Delivery authorization required");
    if (!this.transport.delivery)
      throw new ConflictError("Publisher unavailable");
    const facts = await this.transport.delivery(machine, {
      action: "preflight",
      policy,
    });
    return {
      ready: this.preflightReasons(policy, facts).length === 0,
      reasons: this.preflightReasons(policy, facts),
      facts: redactFactoryOutput(facts),
    };
  }
  private preflightReasons(
    p: DeliveryPolicy,
    f: any,
    includeMergeCapability = true,
  ) {
    const reasons: string[] = [];
    if (f.repositoryNodeId !== p.repositoryNodeId)
      reasons.push("Repository identity mismatch");
    if (!f.canPush) reasons.push("Publisher lacks push permission");
    if (!/^[a-f0-9]{40}$/.test(f.baseSha ?? ""))
      reasons.push("Target branch missing");
    if (
      !p.downstream.confirmed ||
      p.downstream.deploys ||
      f.downstreamSafe !== true
    )
      reasons.push(
        "Downstream scope unknown or deployment requires separate approval",
      );
    if (
      p.operations.includes("merge") &&
      (!f.canMerge || !f.protected || !f.strict)
    )
      reasons.push("Strict enforceable provider protection required");
    if (p.operations.includes("merge") && f.deletesBranchOnMerge)
      reasons.push(
        "Disable provider automatic branch cleanup before MERGED authorization",
      );
    if (
      (p.ciVariablesDigest || f.ciVariablesCount > 0) &&
      f.ciConfigDigest !== p.ciVariablesDigest
    )
      reasons.push("CI configuration changed or is unconfirmed");
    if (
      includeMergeCapability &&
      p.operations.includes("merge") &&
      f.atomicTarget !== true
    )
      reasons.push(
        f.mergeIdentityReason ??
          "Provider cannot atomically enforce the authorized merge target; automatic merge stopped",
      );
    return reasons;
  }
  queue(p?: BotPrincipal) {
    const rows = this.store.db
      .prepare(
        "SELECT key,task_id AS taskId,operation FROM factory_delivery_queue",
      )
      .all() as { key: string; taskId: string; operation: string }[];
    if (!p) return rows;
    const owned = new Set(this.host.list(p).map((t) => t.id));
    return rows.filter((r) => owned.has(r.taskId));
  }
  private acquire(d: DeliveryRecord) {
    this.store.db
      .prepare("INSERT OR IGNORE INTO factory_delivery_queue VALUES(?,?,?)")
      .run(deliveryQueueKey(d.policy), d.taskId, d.pending?.id ?? "prepare");
    return (
      this.queue().find((q) => q.key === deliveryQueueKey(d.policy))?.taskId ===
      d.taskId
    );
  }
  private release(d: DeliveryRecord) {
    if (!d.pending)
      this.store.db
        .prepare("DELETE FROM factory_delivery_queue WHERE key=? AND task_id=?")
        .run(deliveryQueueKey(d.policy), d.taskId);
  }
  private blocked(
    p: BotPrincipal,
    d: DeliveryRecord,
    reason: string,
    stage: DeliveryRecord["stage"] = "WAITING_DECISION",
  ) {
    d.stage = stage;
    d.reason = reason;
    this.event(d, "blocked", { reason, stage });
    this.write(p, d);
    this.release(d);
  }
  private async effect(
    p: BotPrincipal,
    t: FactoryTask,
    d: DeliveryRecord,
    action: "push" | "pr" | "merge",
  ) {
    const latest = this.current(p, t.id)!;
    if (latest.evidenceRecoveryRequired || d.evidenceRecoveryRequired)
      throw new ConflictError(
        "Full delivery evidence recovery required before remote writes",
      );
    if (
      latest.grants.at(-1)?.revoked ||
      ["PAUSED", "CANCELLED"].includes(latest.stage)
    )
      throw new AuthorizationError("Delivery revoked or paused");
    if (!this.withinBudget(p, d))
      throw new ConflictError("Delivery operation deadline exceeded");
    const currentTask = this.host.get(p, t.id);
    if (!this.policyCurrent(p, currentTask, d))
      throw new ConflictError("Delivery policy changed before remote write");
    if (action === "merge" && latest.grants.at(-1)?.scope !== "MERGED")
      throw new ConflictError("Current task grant stops at PR");
    if (
      this.ready(currentTask).sha !== d.candidate ||
      currentTask.development!.generation !== d.generation
    )
      throw new ConflictError(
        "Candidate generation changed before remote write",
      );
    d.pending = { id: randomUUID(), action, sha: d.candidate, at: this.now() };
    this.event(d, "intent", d.pending);
    this.write(p, d);
    if (d.evidenceRecoveryRequired) {
      // The durable intent has not been sent. Retain its audit event, but no writer exists.
      delete d.pending;
      d.stage = "DEFERRED";
      this.write(p, d);
      throw new ConflictError(
        "Full delivery evidence recovery required before remote writes",
      );
    }
    try {
      await this.call(t, d, action, {
        operationId: d.pending.id,
        baseSha: d.deliveryBase,
        acceptance: t.development!.policy.criteria,
        requirement: t.development!.requirement,
      });
      d.pending.finished = true;
      d.pending.outcome = "completed";
    } catch (error) {
      if (
        (error as any)?.publisherFinished &&
        (error as any)?.publisherRefused
      ) {
        d.pending.finished = true;
        d.pending.outcome = "rejected";
      }
      throw error;
    }
  }
  private adopt(d: DeliveryRecord, f: any) {
    const previousPushed = d.pushedSha;
    if (
      previousPushed &&
      f.headSha !== previousPushed &&
      f.headSha !== d.candidate
    )
      throw new ConflictError("External task branch changed");
    if (f.headSha === d.candidate) {
      d.pushedSha = d.candidate;
      if (d.pending?.action === "push") {
        this.event(d, "verified", d.pending);
        delete d.pending;
        delete d.reason;
      }
    }
    if (f.pr) {
      if (
        f.pr.marker !== d.taskId ||
        f.pr.branch !== d.branch ||
        f.pr.base !== d.policy.target ||
        (f.pr.head !== d.candidate && f.pr.head !== previousPushed)
      )
        throw new ConflictError("External PR identity, target or head changed");
      d.pr = f.pr;
      if (d.pending?.action === "pr") {
        this.event(d, "verified", d.pending);
        delete d.pending;
        delete d.reason;
      }
    }
    if (f.pr?.state === "merged") {
      if (
        f.merge?.candidate !== d.candidate ||
        f.merge?.base !== d.deliveryBase ||
        f.merge?.sha !== f.pr.mergeSha ||
        !f.merge?.onTarget ||
        !f.merge?.treeMatches
      )
        throw new ConflictError(
          "Merged candidate or target mapping requires verification",
        );
      d.mergeSha = f.merge.sha;
      d.stage = "MERGED";
      delete d.reason;
      this.event(d, "merge-verified", f.merge);
      delete d.pending;
    }
  }
  private queueExecution(
    p: BotPrincipal,
    t: FactoryTask,
    d: DeliveryRecord,
    baseSha: string,
    ci?: unknown,
  ) {
    const dev = t.development!;
    if (["running", "unknown"].includes(t.status))
      throw new ConflictError(
        "Original executor must finish before continuation",
      );
    if (ci && dev.round >= dev.policy.maxRounds)
      return this.blocked(p, d, "Original repair rounds exhausted");
    dev.executions ??= [];
    dev.executions.push({
      generation: dev.generation,
      machineId: t.machineId,
      repositoryId: t.repositoryId,
      status: t.status,
      result: t.result,
      finishedAt: t.finishedAt,
    });
    dev.reviewCarry = {
      issues: mergeDevelopmentIssueLedger(
        { issueLedger: dev.reviewCarry?.issues ?? [] },
        t.result?.development ?? {},
      ),
    };
    dev.generation++;
    dev.verifyCurrent = false;
    if (ci) dev.round++;
    dev.stage = "QUEUED";
    dev.deliveryInput = { baseSha, previousSha: d.candidate, ci, repair: !!ci };
    t.status = "queued";
    t.seq = 0;
    delete t.startedAt;
    delete t.finishedAt;
    delete t.result;
    delete t.error;
    this.host.updateDevelopment(t);
    d.stage = "SYNC_WAIT";
    this.event(d, ci ? "ci-repair" : "base-sync", {
      baseSha,
      generation: dev.generation,
      round: dev.round,
    });
    this.write(p, d);
    this.release(d);
  }
  private claimController(id: string) {
    if (this.active.has(id) || runningControllers.has(id)) return false;
    const owner = this.store.db
      .prepare(
        "SELECT pid,token FROM factory_delivery_controller WHERE task_id=?",
      )
      .get(id) as { pid: number; token: string } | undefined;
    if (owner) {
      let dead = false;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!dead) return false;
      this.store.db
        .prepare(
          "DELETE FROM factory_delivery_controller WHERE task_id=? AND token=?",
        )
        .run(id, owner.token);
    }
    const claim = this.store.db
      .prepare(
        "INSERT OR IGNORE INTO factory_delivery_controller VALUES(?,?,?)",
      )
      .run(id, process.pid, controllerToken);
    if (!Number(claim.changes)) return false;
    this.active.add(id);
    runningControllers.add(id);
    return true;
  }
  private releaseController(id: string) {
    this.active.delete(id);
    runningControllers.delete(id);
    this.store.db
      .prepare(
        "DELETE FROM factory_delivery_controller WHERE task_id=? AND token=?",
      )
      .run(id, controllerToken);
  }
  private withinBudget(p: BotPrincipal, d: DeliveryRecord) {
    if (this.clock() - Date.parse(d.createdAt) <= d.policy.deadlineMs)
      return true;
    this.blocked(p, d, "Delivery operation deadline exceeded", "DEFERRED");
    return false;
  }
  private revoked(d: DeliveryRecord) {
    return (
      d.grants.at(-1)?.revoked || ["PAUSED", "CANCELLED"].includes(d.stage)
    );
  }
  private policyCurrent(p: BotPrincipal, t: FactoryTask, d: DeliveryRecord) {
    const policy = this.authorize(p, t);
    if (policy.revision === d.policy.revision) return true;
    this.blocked(
      p,
      d,
      "Delivery policy changed; explicit confirmation required",
    );
    return false;
  }
  private syncReady(p: BotPrincipal, t: FactoryTask, d: DeliveryRecord) {
    if (d.stage !== "SYNC_WAIT") return true;
    if (["queued", "running", "unknown"].includes(t.status)) return false;
    if (t.development?.stage !== "READY") {
      this.blocked(
        p,
        d,
        t.error ?? "Synchronization or CI repair requires decision",
      );
      return false;
    }
    const r = this.ready(t);
    if (r.deliveryBase !== t.development.deliveryInput?.baseSha) {
      this.blocked(p, d, "New baseline evidence missing");
      return false;
    }
    d.candidate = r.sha;
    d.deliveryBase = r.deliveryBase;
    d.generation = t.development.generation;
    d.stage = "QUEUED";
    this.event(d, "candidate", { sha: r.sha, base: r.deliveryBase });
    return true;
  }
  private async reconcile(p: BotPrincipal, t: FactoryTask, d: DeliveryRecord) {
    const f = await this.call(t, d, "snapshot");
    if (f.publisher && !d.history.some((e) => e.kind === "publisher"))
      this.event(d, "publisher", f.publisher);
    if (
      f.mergePublisher &&
      !d.history.some(
        (e) =>
          e.kind === "merge-publisher" &&
          JSON.stringify(e.detail) === JSON.stringify(f.mergePublisher),
      )
    )
      this.event(d, "merge-publisher", f.mergePublisher);
    this.adopt(d, f);
    this.write(p, d);
    if (d.stage === "MERGED") {
      this.release(d);
      return null;
    }
    if (f.pr?.state === "closed") {
      this.event(d, "external", f.pr);
      this.blocked(p, d, "PR externally closed");
      return null;
    }
    if (!d.pending) return f;
    const operation = f.operation;
    const ambiguousJournal =
      operation?.error && operation.outcome !== "rejected";
    const rejected =
      !ambiguousJournal &&
      ((d.pending.finished && d.pending.outcome === "rejected") ||
        (operation?.operationId === d.pending.id &&
          operation.completed === true &&
          operation.error === true &&
          operation.outcome === "rejected"));
    // An absent read cannot disprove a sent request or an eventually visible successful write.
    // Legacy finished/error booleans did not distinguish network uncertainty and are not proof.
    if (!rejected) {
      d.stage = "VERIFYING";
      this.write(p, d);
      return null;
    }
    this.event(d, "verified-absent", d.pending);
    delete d.pending;
    this.write(p, d);
    d.attempts++;
    if (d.attempts > d.policy.maxRetries) {
      this.blocked(p, d, "Remote operation retry budget exhausted", "DEFERRED");
      return null;
    }
    return f;
  }
  private async candidateCurrent(
    p: BotPrincipal,
    t: FactoryTask,
    d: DeliveryRecord,
    f: any,
  ) {
    if (!this.policyCurrent(p, t, d)) return false;
    if (f.ciRetryExceeded) {
      this.blocked(
        p,
        d,
        "Remote CI retry budget exceeded; retain every attempt",
      );
      return false;
    }
    const reasons = this.preflightReasons(d.policy, f, false);
    if (reasons.length) {
      this.blocked(p, d, reasons.join("; "));
      return false;
    }
    if (t.development?.stage !== "READY") {
      this.blocked(p, d, t.error ?? "Local development no longer READY");
      return false;
    }
    const r = this.ready(t);
    if (
      r.sha !== d.candidate ||
      t.development.policy.revision !== d.developmentRevision
    ) {
      this.blocked(
        p,
        d,
        "Candidate or development policy changed without revalidation",
      );
      return false;
    }
    if (f.baseSha === d.deliveryBase) return true;
    await this.call(t, d, "sync-artifact", {
      baseSha: f.baseSha,
      baseline: d.originalBase,
    });
    this.queueExecution(p, t, d, f.baseSha);
    return false;
  }
  private artifactCurrent(
    p: BotPrincipal,
    t: FactoryTask,
    d: DeliveryRecord,
    a: any,
  ) {
    const r = this.ready(t);
    if (
      !a.valid ||
      a.sha !== d.candidate ||
      a.baseline !== d.originalBase ||
      a.identity !== d.identity ||
      a.bytes !== r.artifact.bytes ||
      a.digest !== r.artifact.digest ||
      a.bytes < 1 ||
      a.bytes > 700000
    ) {
      this.blocked(
        p,
        d,
        "Artifact identity, integrity or size mismatch",
        "DEFERRED",
      );
      return false;
    }
    if (
      a.privacy?.sha !== d.candidate ||
      !Array.isArray(a.privacy.findings) ||
      a.privacy.findings.length ||
      !Array.isArray(a.sensitive)
    ) {
      this.blocked(p, d, "Unresolved privacy evidence");
      return false;
    }
    if (a.sensitive.length && d.sensitiveConfirmedSha !== d.candidate) {
      this.blocked(
        p,
        d,
        "Sensitive delivery or CI changes require separate current-SHA confirmation",
      );
      return false;
    }
    return true;
  }
  private async verifyEffect(
    p: BotPrincipal,
    t: FactoryTask,
    d: DeliveryRecord,
  ) {
    const facts = await this.call(t, d, "snapshot");
    this.adopt(d, facts);
    if (!d.pending) return facts;
    d.stage = "VERIFYING";
    this.write(p, d);
    return null;
  }
  private async pushCandidate(
    p: BotPrincipal,
    t: FactoryTask,
    d: DeliveryRecord,
    f: any,
  ) {
    if (d.pushedSha === d.candidate) return f;
    const artifact = await this.call(t, d, "artifact");
    if (!this.artifactCurrent(p, t, d, artifact)) return null;
    await this.effect(p, t, d, "push");
    const facts = await this.verifyEffect(p, t, d);
    if (!facts) return null;
    d.stage = "PUSHED";
    this.write(p, d);
    if (this.revoked(d)) {
      this.release(d);
      return null;
    }
    return facts;
  }
  private async ensurePr(
    p: BotPrincipal,
    t: FactoryTask,
    d: DeliveryRecord,
    f: any,
  ) {
    if (d.pr) return f;
    await this.effect(p, t, d, "pr");
    return this.verifyEffect(p, t, d);
  }
  private recordCi(p: BotPrincipal, d: DeliveryRecord, f: any) {
    const checks = Array.isArray(f.checks) ? f.checks : [];
    const previous = d.ciHistory.at(-1);
    if (
      checks.length &&
      JSON.stringify(previous?.checks) !== JSON.stringify(checks)
    ) {
      d.ciHistory.push({
        at: this.now(),
        candidate: d.candidate,
        base: d.deliveryBase,
        checks,
      });
      this.event(d, "ci", checks);
    }
    this.write(p, d);
    return checks;
  }
  private async checkAndMerge(
    p: BotPrincipal,
    t: FactoryTask,
    d: DeliveryRecord,
    f: any,
  ) {
    if (d.grants.at(-1)!.scope === "PR") {
      d.stage = "PR_READY";
      this.write(p, d);
      this.release(d);
      return;
    }
    d.stage = "CI_WAIT";
    const checks = this.recordCi(p, d, f);
    if (d.evidenceRecoveryRequired) {
      this.release(d);
      return;
    }
    const ci = trustedCi(d.policy, d.candidate, d.deliveryBase, checks);
    if (ci.state === "failed") {
      this.queueExecution(p, t, d, d.deliveryBase, ci);
      return;
    }
    if (this.clock() - Date.parse(d.createdAt) > d.policy.deadlineMs) {
      this.blocked(p, d, "Delivery CI deadline exceeded", "DEFERRED");
      return;
    }
    if (ci.state !== "passed" || !f.reviewApproved || !f.mergeable) {
      this.release(d);
      return;
    }
    if (f.atomicTarget !== true) {
      this.blocked(
        p,
        d,
        f.mergeIdentityReason ??
          "Provider cannot atomically enforce the authorized merge target; automatic merge stopped",
      );
      return;
    }
    // Only adapters with a server-enforced authorized target may perform this operation.
    await this.effect(p, t, d, "merge");
    await this.verifyEffect(p, t, d);
    this.write(p, d);
    this.release(d);
  }
  private failAdvance(p: BotPrincipal, d: DeliveryRecord, error: unknown) {
    if (d.evidenceRecoveryRequired || d.stage === "DEFERRED") {
      this.write(p, d);
      this.release(d);
      return;
    }
    if (error instanceof ConflictError) {
      this.blocked(p, d, error.message);
      return;
    }
    if (
      !d.pending &&
      (error as any)?.publisherRefused &&
      ["artifact", "sync-artifact"].includes((error as any).action)
    ) {
      this.blocked(
        p,
        d,
        redactFactoryOutput((error as Error).message),
        "DEFERRED",
      );
      return;
    }
    if (d.pending) {
      d.stage = "VERIFYING";
      d.reason = "Remote write outcome unknown; reconcile before replay";
      this.event(d, "unknown", d.pending);
      this.write(p, d);
      return;
    }
    d.attempts++;
    this.blocked(
      p,
      d,
      "Publisher unavailable; bounded retry",
      d.attempts > d.policy.maxRetries ? "DEFERRED" : "QUEUED",
    );
  }
  private async reconcileStopped(
    p: BotPrincipal,
    t: FactoryTask,
    d: DeliveryRecord,
  ) {
    const stage = d.stage,
      reason = d.reason;
    let verified = true;
    try {
      await this.reconcile(p, t, d);
    } catch (error) {
      verified = false;
      this.event(d, "stopped-reconciliation-unavailable", {
        reason:
          error instanceof ConflictError
            ? error.message
            : "Remote read unavailable; original decision remains required",
      });
    }
    if (d.stage !== "MERGED") {
      d.stage = stage;
      d.reason = reason;
    }
    this.write(p, d);
    this.release(d);
    return verified;
  }
  async verifyRemote(p: BotPrincipal, id: string) {
    this.host.get(p, id);
    if (!this.claimController(id))
      throw new ConflictError("Remote verification already in progress");
    try {
      const d = this.current(p, id);
      if (!d) throw new ConflictError("No task delivery grant to verify");
      const t = this.host.get(p, id);
      if (stoppedDeliveryStages.has(d.stage)) {
        if (!(await this.reconcileStopped(p, t, d)))
          throw new ConflictError(
            "Remote outcome remains unverified; inspect retained evidence",
          );
      } else await this.reconcile(p, t, d);
      return this.current(p, id)!;
    } finally {
      this.releaseController(id);
    }
  }
  async advance(p: BotPrincipal, id: string) {
    if (!this.claimController(id)) return;
    const d = this.current(p, id);
    try {
      if (!d) return;
      const stopped = stoppedDeliveryStages.has(d.stage);
      if ((stopped || d.evidenceRecoveryRequired) && !d.pending) return;
      const t = this.host.get(p, id);
      if (stopped) {
        if (this.acquire(d)) await this.reconcileStopped(p, t, d);
        return;
      }
      if (!d.pending && !this.withinBudget(p, d)) return;
      if (this.revoked(d) && !d.pending) return;
      if (!d.pending && !this.revoked(d) && !this.policyCurrent(p, t, d))
        return;
      if (!this.syncReady(p, t, d) || !this.acquire(d)) return;
      let f = await this.reconcile(p, t, d);
      if (!f) return;
      if (d.evidenceRecoveryRequired) {
        this.release(d);
        return;
      }
      if (this.revoked(d)) {
        this.release(d);
        return;
      }
      if (!(await this.candidateCurrent(p, t, d, f))) return;
      f = await this.pushCandidate(p, t, d, f);
      if (!f) return;
      f = await this.ensurePr(p, t, d, f);
      if (!f) return;
      await this.checkAndMerge(p, t, d, f);
    } catch (error) {
      if (d) this.failAdvance(p, d, error);
    } finally {
      this.releaseController(id);
    }
  }
  control(p: BotPrincipal, id: string, action: string) {
    const t = this.host.get(p, id);
    // The authenticated task owner can always stop future writes, including after policy disablement.
    const d = this.current(p, id);
    if (!d) throw new ValidationError("No task delivery grant");
    if (!["pause", "cancel", "revoke"].includes(action))
      throw new ValidationError("Unsupported delivery control");
    d.controlVersion = (d.controlVersion ?? 0) + 1;
    if (action === "revoke") d.grants.at(-1)!.revoked = true;
    d.stage = action === "pause" ? "PAUSED" : "CANCELLED";
    this.event(d, action, { actor: p.userId });
    this.write(p, d);
    this.release(d);
    return d;
  }
  private addTaskRounds(
    p: BotPrincipal,
    t: FactoryTask,
    d: DeliveryRecord,
    value: unknown,
  ) {
    if (
      d.stage !== "WAITING_DECISION" ||
      d.reason !== "Original repair rounds exhausted"
    )
      throw new ConflictError(
        "Task is not awaiting a CI repair budget decision",
      );
    this.ready(t);
    const rounds = Number(value);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20)
      throw new ValidationError("Bounded additional rounds required");
    t.development!.policy.maxRounds += rounds;
    t.development!.decisions.push({
      userId: p.userId,
      at: this.now(),
      action: "add-rounds",
      rounds,
    });
    this.host.updateDevelopment(t);
  }
  decide(p: BotPrincipal, id: string, input: any) {
    const t = this.host.get(p, id);
    this.authorize(p, t);
    const d = this.current(p, id);
    if (
      !d ||
      !["resume", "confirm-sensitive", "add-rounds"].includes(input?.action)
    )
      throw new ValidationError(
        "Explicit supported delivery decision required",
      );
    if (d.pending || d.evidenceRecoveryRequired)
      throw new ConflictError(
        "Verify outstanding writer and recover full evidence first",
      );
    if (input.action === "confirm-sensitive") {
      if (input.sha !== d.candidate)
        throw new ValidationError("Exact candidate confirmation required");
      d.sensitiveConfirmedSha = d.candidate;
    }
    if (d.grants.at(-1)?.revoked)
      throw new AuthorizationError("New grant required");
    if (input.action === "add-rounds")
      this.addTaskRounds(p, t, d, input.rounds);
    d.controlVersion = (d.controlVersion ?? 0) + 1;
    d.decisions.push({
      userId: p.userId,
      at: this.now(),
      action: input.action,
      sha: input.sha,
      ...(input.action === "add-rounds"
        ? { rounds: Number(input.rounds) }
        : {}),
    });
    d.stage = "QUEUED";
    delete d.reason;
    this.write(p, d);
    return d;
  }
  async tick() {
    const rows = this.store.db
      .prepare(
        "SELECT principal,task_id FROM factory_delivery WHERE json_extract(data,'$.pending') IS NOT NULL OR json_extract(data,'$.stage') NOT IN ('MERGED','PR_READY','DEFERRED','WAITING_DECISION','PAUSED','CANCELLED')",
      )
      .all() as { principal: string; task_id: string }[];
    for (const row of rows) {
      const [tenantId, userId] = JSON.parse(row.principal);
      await this.advance({ tenantId, userId }, row.task_id);
    }
  }
}
