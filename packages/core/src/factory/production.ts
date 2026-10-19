import { createHash, randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { dirname } from "node:path";
import { accessSync, constants, statfsSync } from "node:fs";
import { botPrincipalKey, type BotPrincipal } from "../bots/bot-identity.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import type { SqliteStateStore } from "../storage.js";
import type { FactorySettings } from "./types.js";

export interface ProductionPlan {
  environment: "local";
  host: string;
  entryUrl: string;
  visibility: "private" | "public";
  repository: string;
  repositoryNodeId: string;
  target: string;
  workerIds: string[];
  modelIds: string[];
  connectionIds: string[];
  sourceSha: string;
  daemonDigest: string;
  webDigest: string;
  maxTasks: number;
  maxRounds: number;
  maxCostUsd: number;
  deadlineMs: number;
  minFreeDiskGiB: number;
  scopeConfirmed: boolean;
  publicConfirmed: boolean;
  revision?: string;
}
export const PRODUCTION_GATES = [
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
  "runtime-identity",
  "real-project",
  "backup-restore",
  "cutover-rollback",
  "review",
] as const;
export interface ProductionRun {
  id: string;
  stage: "LOCAL_ONLY";
  settings: ProductionPlan;
  createdAt: string;
  updatedAt: string;
  assessment?: ReturnType<FactoryProduction["assessment"]>;
}
export function defaultProductionPlan(): ProductionPlan {
  return {
    environment: "local",
    host: "",
    entryUrl: "",
    visibility: "private",
    repository: "",
    repositoryNodeId: "",
    target: "main",
    workerIds: [],
    modelIds: [],
    connectionIds: [],
    sourceSha: "",
    daemonDigest: "",
    webDigest: "",
    maxTasks: 2,
    maxRounds: 8,
    maxCostUsd: 0,
    deadlineMs: 14400000,
    minFreeDiskGiB: 14,
    scopeConfirmed: false,
    publicConfirmed: false,
  };
}
const stringFields = [
  "host",
  "entryUrl",
  "visibility",
  "repository",
  "repositoryNodeId",
  "target",
  "sourceSha",
  "daemonDigest",
  "webDigest",
] as const;
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new ValidationError(
      "Unsupported production field; credentials and commands are forbidden",
    );
}
function boundedNumber(
  value: unknown,
  min: number,
  max: number,
  integer = true,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new ValidationError("Invalid production limit");
  return value;
}
function identifiers(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    value.some(
      (x) => typeof x !== "string" || !/^[-A-Za-z0-9_./:]{1,150}$/.test(x),
    )
  )
    throw new ValidationError("Invalid production identifiers");
  return [...new Set(value)];
}
function validateStrings(p: ProductionPlan) {
  for (const field of stringFields)
    if (
      typeof p[field] !== "string" ||
      p[field].length > 300 ||
      /[\x00-\x1f]/.test(p[field])
    )
      throw new ValidationError("Invalid production text");
  if (p.host && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(p.host))
    throw new ValidationError("Registered host alias required");
  if (p.repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository))
    throw new ValidationError("Canonical repository required");
  if (
    p.repositoryNodeId &&
    !/^[-A-Za-z0-9_+/=]{1,200}$/.test(p.repositoryNodeId)
  )
    throw new ValidationError("Repository identity required");
  if (
    !/^(?![./])(?!.*(?:\.\.|@\{|[ ~^:?*\[\\]))[A-Za-z0-9_./-]{1,180}(?<![./])$/.test(
      p.target,
    )
  )
    throw new ValidationError("Invalid production target");
  if (p.sourceSha && !/^[a-f0-9]{40}$/.test(p.sourceSha))
    throw new ValidationError("Exact source SHA required");
  for (const role of ["daemonDigest", "webDigest"] as const)
    if (p[role] && !/^sha256:[a-f0-9]{64}$/.test(p[role]))
      throw new ValidationError("Immutable image digest required");
}
function validateEntry(p: ProductionPlan) {
  if (p.entryUrl) {
    let url: URL;
    try {
      url = new URL(p.entryUrl);
    } catch {
      throw new ValidationError("Invalid entry URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new ValidationError(
        "Entry URL must not contain credentials or parameters",
      );
  }
  if (
    !["private", "public"].includes(p.visibility) ||
    typeof p.publicConfirmed !== "boolean" ||
    typeof p.scopeConfirmed !== "boolean"
  )
    throw new ValidationError(
      "Explicit production visibility and scope required",
    );
  if (p.visibility === "public" && !p.publicConfirmed)
    throw new ValidationError("Public disclosure confirmation required");
}
export function parseProductionPlan(value: unknown): ProductionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("Production settings required");
  const keys = Object.keys(defaultProductionPlan());
  exactKeys(value as Record<string, unknown>, [...keys, "revision"]);
  if (
    /-----BEGIN .*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{20,})|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/.test(
      JSON.stringify(value),
    )
  )
    throw new ValidationError(
      "Credentials must remain in private runtime references",
    );
  const p = structuredClone(value) as ProductionPlan;
  if (p.environment !== "local")
    throw new ValidationError("Only local preparation is currently enabled");
  validateStrings(p);
  validateEntry(p);
  p.workerIds = identifiers(p.workerIds);
  p.modelIds = identifiers(p.modelIds);
  p.connectionIds = identifiers(p.connectionIds);
  p.maxTasks = boundedNumber(p.maxTasks, 1, 1000000);
  p.maxRounds = boundedNumber(p.maxRounds, 1, 100);
  p.maxCostUsd = boundedNumber(p.maxCostUsd, 0, 1000000, false);
  p.deadlineMs = boundedNumber(p.deadlineMs, 1000, 604800000);
  p.minFreeDiskGiB = boundedNumber(p.minFreeDiskGiB, 14, 1000000);
  delete p.revision;
  p.revision = createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(keys.map((k) => [k, p[k as keyof ProductionPlan]])),
      ),
    )
    .digest("hex");
  return p;
}
/** Local preparation only: no remote transport, deployment command, activation or report ingestion API.
 * Persistent immutable snapshots preserve what was checked without turning user assertions into evidence. */
export class FactoryProduction {
  constructor(
    private store: SqliteStateStore,
    private host: { settings(p: BotPrincipal): FactorySettings },
    private clock: () => number = Date.now,
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS factory_production_runs(id TEXT PRIMARY KEY,principal TEXT NOT NULL,request_key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(principal,request_key));",
    );
  }
  private key(p: BotPrincipal) {
    return "factory.production:" + botPrincipalKey(p);
  }
  settings(p: BotPrincipal): ProductionPlan {
    return (
      this.store.getDaemonControl<ProductionPlan>(this.key(p)) ??
      defaultProductionPlan()
    );
  }
  save(p: BotPrincipal, input: unknown) {
    const plan = parseProductionPlan(input);
    this.store.setDaemonControl(this.key(p), plan);
    return plan;
  }
  preflight(p: BotPrincipal, plan = this.settings(p)) {
    const blockers = ["local-only"];
    if (!plan.scopeConfirmed || !plan.host || !plan.entryUrl)
      blockers.push("deployment-scope-unconfirmed");
    if (!plan.repository || !plan.repositoryNodeId)
      blockers.push("real-project-unconfirmed");
    if (!plan.sourceSha || !plan.daemonDigest || !plan.webDigest)
      blockers.push("candidate-unconfirmed");
    const machines = this.host.settings(p).machines;
    if (
      plan.workerIds.length < 2 ||
      plan.workerIds.some(
        (id) =>
          !machines.some(
            (m) => m.id === id && m.allowedUserIds.includes(p.userId),
          ),
      )
    )
      blockers.push("workers-unconfirmed");
    if (!plan.modelIds.length || !plan.connectionIds.length)
      blockers.push("supported-connections-unconfirmed");
    if (!plan.maxCostUsd) blockers.push("model-budget-unconfirmed");
    let database = false,
      writable = false,
      freeDiskGiB: number | null = null;
    try {
      database = this.store.db.prepare("SELECT 1 AS ok").get()?.ok === 1;
      accessSync(dirname(this.store.dbPath), constants.W_OK);
      writable = true;
      const s = statfsSync(dirname(this.store.dbPath));
      freeDiskGiB = (s.bavail * s.bsize) / 1024 ** 3;
    } catch {
      /* A missing observation must not be treated as success. */
    }
    if (!database || !writable) blockers.push("local-storage-unavailable");
    if (freeDiskGiB === null || freeDiskGiB < plan.minFreeDiskGiB)
      blockers.push("local-disk-insufficient");
    return {
      scope: "local" as const,
      ready: false,
      canDeploy: false,
      blockers,
      observed: {
        platform: process.platform,
        node: process.version,
        cpu: availableParallelism(),
        database,
        writable,
        freeDiskGiB,
        remoteHosts: "not_probed" as const,
      },
      requiredScope: {
        factoryDeployment: "unconfirmed",
        businessDeployment: "not_authorized",
      },
    };
  }
  create(p: BotPrincipal, input: unknown): ProductionRun {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ValidationError("Local run request required");
    exactKeys(input as Record<string, unknown>, [
      "requestKey",
      "expectedRevision",
    ]);
    const expectedRevision = (input as { expectedRevision?: unknown })
      .expectedRevision;
    if (
      expectedRevision !== undefined &&
      (typeof expectedRevision !== "string" ||
        !/^[a-f0-9]{64}$/.test(expectedRevision))
    )
      throw new ValidationError("Invalid settings revision");
    const requestKey = (input as { requestKey?: unknown }).requestKey;
    if (
      typeof requestKey !== "string" ||
      !/^[-A-Za-z0-9_]{1,100}$/.test(requestKey)
    )
      throw new ValidationError("Stable request identity required");
    const ownsTransaction = !this.store.db.isTransaction;
    if (ownsTransaction) this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const settings = this.settings(p);
      if (!settings.revision)
        throw new ConflictError(
          "Save production settings before freezing a run",
        );
      if (
        expectedRevision !== undefined &&
        expectedRevision !== settings.revision
      )
        throw new ConflictError(
          "Production settings changed; reload before freezing a run",
        );
      const result = this.createLocked(p, requestKey, settings);
      if (ownsTransaction) this.store.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (ownsTransaction) this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  private createLocked(
    p: BotPrincipal,
    requestKey: string,
    settings: ProductionPlan,
  ): ProductionRun {
    const principal = botPrincipalKey(p),
      prior = this.store.db
        .prepare(
          "SELECT data FROM factory_production_runs WHERE principal=? AND request_key=?",
        )
        .get(principal, requestKey) as { data: string } | undefined;
    if (prior) {
      const run = JSON.parse(prior.data) as ProductionRun;
      if (run.settings.revision !== settings.revision)
        throw new ConflictError(
          "Request identity belongs to another settings revision",
        );
      return run;
    }
    const at = new Date(this.clock()).toISOString(),
      run: ProductionRun = {
        id: "production_" + randomUUID(),
        stage: "LOCAL_ONLY",
        settings: structuredClone(settings),
        createdAt: at,
        updatedAt: at,
      };
    this.store.db
      .prepare("INSERT INTO factory_production_runs VALUES(?,?,?,?)")
      .run(run.id, principal, requestKey, JSON.stringify(run));
    return run;
  }
  get(p: BotPrincipal, id: string): ProductionRun {
    const row = this.store.db
      .prepare(
        "SELECT data FROM factory_production_runs WHERE id=? AND principal=?",
      )
      .get(id, botPrincipalKey(p)) as { data: string } | undefined;
    if (!row) throw new NotFoundError("Local production run");
    return JSON.parse(row.data);
  }
  list(p: BotPrincipal): ProductionRun[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM factory_production_runs WHERE principal=? ORDER BY rowid DESC LIMIT 50",
        )
        .all(botPrincipalKey(p)) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  assessment(p: BotPrincipal, id: string) {
    const run = this.get(p, id),
      preflight = this.preflight(p, run.settings),
      blockers = [...preflight.blockers];
    if (run.settings.revision !== this.settings(p).revision)
      blockers.push("settings-changed");
    if (this.clock() - Date.parse(run.createdAt) > run.settings.deadlineMs)
      blockers.push("run-deadline-exceeded");
    return {
      ready: false,
      canPromote: false,
      scope: "local" as const,
      deployment: "not_deployed",
      businessDeployment: "not_authorized",
      blockers,
      missing: [...PRODUCTION_GATES],
      candidate: {
        sourceSha: run.settings.sourceSha,
        daemonDigest: run.settings.daemonDigest,
        webDigest: run.settings.webDigest,
      },
      preflight,
    };
  }
  assess(p: BotPrincipal, id: string, input: unknown) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length
    )
      throw new ValidationError(
        "Evaluation reads server evidence; submitted pass claims are forbidden",
      );
    const run = this.get(p, id);
    run.assessment = this.assessment(p, id);
    run.updatedAt = new Date(this.clock()).toISOString();
    this.store.db
      .prepare(
        "UPDATE factory_production_runs SET data=? WHERE id=? AND principal=?",
      )
      .run(JSON.stringify(run), id, botPrincipalKey(p));
    return { run, assessment: run.assessment };
  }
}
