import { redactFactoryOutput } from "./redaction.js";
import { createHash, randomUUID } from "node:crypto";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../errors.js";
import {
  botPrincipalKey,
  sameBotPrincipal,
  type BotPrincipal,
} from "../bots/bot-identity.js";
import {
  assertBotRoomTarget,
  deliverBotRoomMessage,
  type BotRoomService,
} from "../rooms/index.js";
import type { SqliteStateStore } from "../storage.js";
import { SshFactoryTransport } from "./transport.js";
import type {
  FactoryMachine,
  FactoryOperation,
  FactoryReport,
  FactorySettings,
  FactoryStatus,
  FactoryTask,
  FactoryTransport,
  PatrolState,
} from "./types.js";
export type {
  FactoryMachine,
  FactoryTask,
  FactorySettings,
  FactoryTransport,
} from "./types.js";
const TERMINAL = new Set<FactoryStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);
const OPS = new Set(["snapshot", "count-files", "read-log"]);
const IDENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const isObj = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function text(v: unknown, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new ValidationError("Invalid factory value");
  return v.trim();
}
function identifier(v: unknown): string {
  const s = text(v, 80);
  if (!IDENT.test(s)) throw new ValidationError("Invalid identifier");
  return s;
}
function strings(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 100)
    throw new ValidationError("Expected list");
  return [...new Set(v.map((x) => text(x)))];
}
function path(v: unknown): string {
  const s = text(v, 2048);
  if (!s.startsWith("/") || /[\x00-\x1f]/.test(s))
    throw new ValidationError("Absolute repository path required");
  return s;
}
export class FactoryService {
  private readonly pending = new Set<Promise<unknown>>();
  private ticking = false;
  private tickPromise?: Promise<void>;
  private closed = false;
  constructor(
    private host: { store: SqliteStateStore; rooms: BotRoomService },
    private transport: FactoryTransport = new SshFactoryTransport(),
    private clock: () => number = Date.now,
  ) {
    host.store.db
      .exec(`CREATE TABLE IF NOT EXISTS factory_tasks(id TEXT PRIMARY KEY,principal TEXT NOT NULL,machine_id TEXT NOT NULL,status TEXT NOT NULL,idem TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(principal,idem));
   CREATE TABLE IF NOT EXISTS factory_outbox(key TEXT PRIMARY KEY,principal TEXT NOT NULL,room_id TEXT NOT NULL,bot_id TEXT NOT NULL,body TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);`);
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private key(p: BotPrincipal) {
    return "factory.settings:" + botPrincipalKey(p);
  }
  private tx<T>(fn: () => T): T {
    const db = this.host.store.db;
    if (db.isTransaction) return fn();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  settings(p: BotPrincipal): FactorySettings {
    return (
      this.host.store.getDaemonControl<FactorySettings>(this.key(p)) ?? {
        owner: p,
        machines: [],
        roomId: "",
        coordinatorBotId: "",
        patrol: { enabled: false, timezone: "Asia/Shanghai" },
      }
    );
  }
  saveSettings(p: BotPrincipal, input: unknown): FactorySettings {
    if (
      !isObj(input) ||
      !Array.isArray(input.machines) ||
      input.machines.length > 50
    )
      throw new ValidationError("Invalid machines");
    const previous = this.settings(p),
      seen = new Set<string>();
    const machines = input.machines.map((value) => {
      if (!isObj(value)) throw new ValidationError("Invalid machine");
      const id = identifier(value.id);
      if (seen.has(id)) throw new ValidationError("Duplicate machine");
      seen.add(id);
      const alias = identifier(value.sshAlias);
      if (
        !Number.isInteger(value.capacity) ||
        Number(value.capacity) < 0 ||
        Number(value.capacity) > 20
      )
        throw new ValidationError("Capacity must be 0–20");
      const botIds = strings(value.botIds);
      for (const bot of botIds)
        if (!this.host.store.getBot(bot))
          throw new ValidationError("Unknown Bot");
      if (!Array.isArray(value.repositories) || value.repositories.length > 20)
        throw new ValidationError("Invalid repositories");
      const repoIds = new Set<string>();
      const repositories = value.repositories.map((repo) => {
        if (!isObj(repo)) throw new ValidationError("Invalid repository");
        const rid = identifier(repo.id);
        if (repoIds.has(rid)) throw new ValidationError("Duplicate repository");
        repoIds.add(rid);
        let logs: { id: string; path: string }[] | undefined;
        if (repo.logs !== undefined) {
          if (!Array.isArray(repo.logs) || repo.logs.length > 20)
            throw new ValidationError("Invalid logs");
          const lids = new Set<string>();
          logs = repo.logs.map((log) => {
            if (!isObj(log)) throw new ValidationError("Invalid log");
            const lid = identifier(log.id);
            if (lids.has(lid)) throw new ValidationError("Duplicate log");
            lids.add(lid);
            return { id: lid, path: path(log.path) };
          });
        }
        return { id: rid, path: path(repo.path), ...(logs ? { logs } : {}) };
      });
      // Two aliases for one verified host may not create extra execution slots.
      const old = previous.machines.find(
        (m) => m.id === id && m.sshAlias === alias,
      );
      return {
        id,
        name: text(value.name),
        sshAlias: alias,
        capacity: Number(value.capacity),
        botIds,
        allowedUserIds: strings(value.allowedUserIds),
        repositories,
        ...(old?.identity
          ? {
              identity: old.identity,
              online: old.online,
              checkedAt: old.checkedAt,
            }
          : {}),
      };
    });
    const roomId = text(input.roomId),
      coordinatorBotId = text(input.coordinatorBotId);
    assertBotRoomTarget(this.host.store, roomId, coordinatorBotId, p);
    // Endpoint changes/removal while occupied would hide running work. Require reconciliation first.
    const occupied = this.all().filter((t) =>
      ["running", "unknown"].includes(t.status),
    );
    for (const task of occupied) {
      const m = machines.find((m) => m.id === task.machineId);
      if (
        sameBotPrincipal(task.principal, p) &&
        (!m || m.sshAlias !== task.machine.sshAlias)
      )
        throw new ConflictError("Machine has unverified running work");
    }
    const next: FactorySettings = {
      owner: p,
      machines,
      roomId,
      coordinatorBotId,
      patrol: previous.patrol,
    };
    this.host.store.setDaemonControl(this.key(p), next);
    return next;
  }
  private configs(): FactorySettings[] {
    return (
      this.host.store.db
        .prepare(
          "SELECT value_json FROM daemon_control WHERE key LIKE 'factory.settings:%'",
        )
        .all() as { value_json: string }[]
    ).map((r) => JSON.parse(r.value_json));
  }
  private machine(p: BotPrincipal, id: string) {
    const m = this.settings(p).machines.find((m) => m.id === id);
    if (!m) throw new NotFoundError("Machine");
    if (!m.allowedUserIds.includes(p.userId)) throw new AuthorizationError();
    return m;
  }
  async probe(p: BotPrincipal, id: string) {
    const m = this.machine(p, id);
    // Settings can change while SSH is in flight. Never attach a receipt from an
    // old endpoint to the replacement machine, or preserve revoked access.
    const stillCurrent = () =>
      this.settings(p).machines.some(
        (current) =>
          current.id === id &&
          current.sshAlias === m.sshAlias &&
          current.allowedUserIds.includes(p.userId),
      );
    try {
      const result = await this.transport.probe(m);
      if (this.closed) return { online: false };
      if (!stillCurrent())
        return {
          online: false,
          error:
            "Machine configuration or permission changed during connection check",
        };
      this.machineState(p, id, { identity: result.identity, online: true });
      return { ...result, online: true };
    } catch {
      if (!this.closed && stillCurrent())
        this.machineState(p, id, { online: false });
      return {
        online: false,
        error: "Connection unavailable; verify SSH alias and host access",
      };
    }
  }
  private machineState(
    p: BotPrincipal,
    id: string,
    patch: Partial<FactoryMachine>,
  ) {
    const cfg = this.settings(p);
    cfg.machines = cfg.machines.map((m) =>
      m.id === id ? { ...m, ...patch, checkedAt: this.now() } : m,
    );
    this.host.store.setDaemonControl(this.key(p), cfg);
  }
  private all(): FactoryTask[] {
    return (
      this.host.store.db
        .prepare("SELECT data FROM factory_tasks ORDER BY rowid")
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  list(p: BotPrincipal) {
    return this.all().filter((t) => sameBotPrincipal(t.principal, p));
  }
  get(p: BotPrincipal, id: string): FactoryTask {
    const task = this.raw(id);
    if (!sameBotPrincipal(task.principal, p)) throw new AuthorizationError();
    return task;
  }
  private raw(id: string): FactoryTask {
    const row = this.host.store.db
      .prepare("SELECT data FROM factory_tasks WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new NotFoundError("Factory task");
    return JSON.parse(row.data);
  }
  private write(t: FactoryTask) {
    this.host.store.db
      .prepare("UPDATE factory_tasks SET status=?,data=? WHERE id=?")
      .run(t.status, JSON.stringify(t), t.id);
  }
  submit(p: BotPrincipal, input: unknown): FactoryTask {
    if (!isObj(input)) throw new ValidationError("Invalid task");
    if (
      Object.keys(input).some(
        (k) =>
          ![
            "machineId",
            "repositoryId",
            "operation",
            "requestKey",
            "roomId",
            "botId",
            "logId",
            "timeoutMs",
          ].includes(k),
      ) ||
      !OPS.has(String(input.operation))
    )
      throw new ValidationError(
        "Read-only pilot: only snapshot, count-files and configured read-log operations are allowed",
      );
    const m = this.machine(p, text(input.machineId));
    if (m.capacity === 0) throw new ValidationError("Machine capacity is zero");
    const repository = m.repositories.find((r) => r.id === input.repositoryId);
    if (!repository) throw new ValidationError("Unknown repository");
    const botId = typeof input.botId === "string" ? input.botId : m.botIds[0];
    if (!botId || !m.botIds.includes(botId))
      throw new AuthorizationError("Bot is not bound to machine");
    if (
      input.operation === "read-log" &&
      !repository.logs?.some((l) => l.id === input.logId)
    )
      throw new ValidationError("Unknown configured log");
    const cfg = this.settings(p),
      roomId = typeof input.roomId === "string" ? input.roomId : cfg.roomId;
    assertBotRoomTarget(this.host.store, roomId, cfg.coordinatorBotId, p);
    const requestKey = text(input.requestKey, 200);
    const timeoutMs =
      input.timeoutMs === undefined ? 30000 : Number(input.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000)
      throw new ValidationError("Timeout must be 1000–120000ms");
    return this.tx(() => {
      const old = this.host.store.db
        .prepare("SELECT data FROM factory_tasks WHERE principal=? AND idem=?")
        .get(botPrincipalKey(p), requestKey) as { data: string } | undefined;
      if (old) return JSON.parse(old.data);
      const at = this.now();
      const task: FactoryTask = {
        id: "factory_" + randomUUID(),
        principal: p,
        machineId: m.id,
        machine: structuredClone(m),
        repositoryId: repository.id,
        repositoryPath: repository.path,
        operation: input.operation as FactoryOperation,
        logId: typeof input.logId === "string" ? input.logId : undefined,
        botId,
        roomId,
        coordinatorBotId: cfg.coordinatorBotId,
        requestKey,
        timeoutMs,
        status: "queued",
        seq: 0,
        createdAt: at,
        updatedAt: at,
        history: [{ status: "queued", at }],
      };
      this.host.store.db
        .prepare("INSERT INTO factory_tasks VALUES(?,?,?,?,?,?)")
        .run(
          task.id,
          botPrincipalKey(p),
          m.id,
          task.status,
          requestKey,
          JSON.stringify(task),
        );
      return task;
    });
  }
  fromRoom(
    p: BotPrincipal,
    roomId: string,
    message: string,
    requestKey: string,
  ): FactoryTask | undefined {
    if (!message.trim().startsWith("/factory ")) return undefined;
    const cfg = this.settings(p);
    if (roomId !== cfg.roomId)
      throw new AuthorizationError("Room is not configured for factory");
    const room = this.host.rooms.get(p, roomId);
    const parts = message.trim().split(/\s+/);
    if (parts[1] === "status" && parts.length === 3)
      return this.get(p, parts[2]!);
    if (parts[1] !== "run" || parts.length < 5 || parts.length > 6)
      throw new ValidationError(
        "Use /factory run <machine> <repository> <snapshot|count-files|read-log> [logId] or /factory status <task>",
      );
    if (room.status !== "active") throw new ConflictError("Room is paused");
    return this.submit(p, {
      machineId: parts[2],
      repositoryId: parts[3],
      operation: parts[4],
      ...(parts[5] ? { logId: parts[5] } : {}),
      roomId,
      requestKey:
        "room:" +
        createHash("sha256")
          .update(JSON.stringify([roomId, requestKey]))
          .digest("hex"),
    });
  }
  acknowledge(t: FactoryTask, key: string) {
    this.outbox(
      t,
      "ack:" +
        createHash("sha256")
          .update(JSON.stringify([botPrincipalKey(t.principal), t.id, key]))
          .digest("hex"),
      `[factory] ${t.id} ${t.machineId} ${t.status}\n${JSON.stringify({ updatedAt: t.updatedAt, result: t.result, error: t.error })}`,
    );
    this.flushOutbox();
  }
  board(p: BotPrincipal) {
    const tasks = this.list(p);
    return {
      tasks,
      machines: this.settings(p).machines.map((m) => ({
        ...m,
        occupied: this.all().filter(
          (t) =>
            this.sameHost(t.machine, m) &&
            ["running", "unknown"].includes(t.status),
        ).length,
      })),
    };
  }
  private sameHost(a: FactoryMachine, b: FactoryMachine) {
    return (
      a.sshAlias === b.sshAlias ||
      !!(a.identity && b.identity && a.identity === b.identity)
    );
  }
  private claim(id: string): FactoryTask | undefined {
    return this.tx(() => {
      const t = this.raw(id);
      if (t.status !== "queued") return;
      const m = this.machine(t.principal, t.machineId);
      if (!m.online || m.capacity === 0) return;
      const hosts = this.configs()
        .flatMap((c) => c.machines)
        .filter((other) => this.sameHost(m, other));
      const cap = Math.min(m.capacity, ...hosts.map((h) => h.capacity));
      const occupied = this.all().filter(
        (other) =>
          this.sameHost(other.machine, m) &&
          ["running", "unknown"].includes(other.status),
      ).length;
      if (occupied >= cap) return;
      t.machine = structuredClone(m);
      t.status = "running";
      t.identity = m.identity;
      t.startedAt = this.now();
      t.updatedAt = t.startedAt;
      t.history.push({ status: t.status, at: t.updatedAt });
      this.write(t);
      return t;
    });
  }
  acceptReport(id: string, r: FactoryReport) {
    r = redactFactoryOutput(r);
    if (this.closed || !this.host.store.db.isOpen) return;
    this.tx(() => {
      const t = this.raw(id);
      if (
        TERMINAL.has(t.status) ||
        !Number.isSafeInteger(r.seq) ||
        r.seq < t.seq ||
        (r.seq === t.seq && r.status === t.status)
      )
        return;
      if (r.identity && t.identity && r.identity !== t.identity) {
        r = {
          status: "unknown",
          seq: r.seq,
          error: "Machine identity changed; verify execution",
          finished: false,
        };
      }
      if (TERMINAL.has(r.status) && !r.finished)
        r = { ...r, status: "unknown" };
      if (!["running", "unknown", ...TERMINAL].includes(r.status)) return;
      const before = t.status;
      t.status = r.status;
      t.seq = r.seq;
      t.lastCheckedAt = this.now();
      t.error = r.error;
      t.result = r.result ?? t.result;
      t.identity = r.identity ?? t.identity;
      // A poll is not progress: unchanged reports do not refresh progress timestamps.
      if (before !== t.status || r.result) {
        t.updatedAt = this.now();
        if (before !== t.status)
          t.history.push({ status: t.status, at: t.updatedAt });
      }
      if (TERMINAL.has(t.status)) t.finishedAt = this.now();
      this.write(t);
      if (
        before !== t.status &&
        (TERMINAL.has(t.status) || t.status === "unknown")
      )
        this.outbox(
          t,
          "result:" + t.id + ":" + t.status,
          `[factory] ${t.id} ${t.machineId} ${t.status}\n${JSON.stringify(t.result ?? {})}${t.error ? "\n" + t.error : ""}`,
        );
    });
  }
  private unknown(id: string) {
    if (this.closed || !this.host.store.db.isOpen) return;
    this.tx(() => {
      const t = this.raw(id);
      if (TERMINAL.has(t.status)) return;
      if (t.status !== "unknown") {
        t.status = "unknown";
        t.updatedAt = this.now();
        t.error = "Connection lost; execution needs verification";
        t.history.push({ status: t.status, at: t.updatedAt });
        this.write(t);
        this.outbox(
          t,
          "result:" + t.id + ":unknown",
          `[factory] ${t.id} ${t.machineId} unknown: execution needs verification`,
        );
      }
      this.machineState(t.principal, t.machineId, { online: false });
    });
  }
  private track(p: Promise<unknown>) {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => {});
  }
  tick(): Promise<void> {
    if (this.closed || this.ticking) return Promise.resolve();
    const work = this.runTick();
    this.tickPromise = work;
    return work;
  }
  private async runTick() {
    this.ticking = true;
    try {
      // Reconcile first. Never re-send a start for claimed/unknown work, even after restart.
      for (const task of this.all().filter((t) =>
        ["running", "unknown"].includes(t.status),
      )) {
        try {
          const r = await this.transport.status(task.machine, task);
          if (this.closed) return;
          this.acceptReport(task.id, r);
          this.machineState(task.principal, task.machineId, { online: true });
        } catch {
          this.unknown(task.id);
        }
      }
      const checked = new Set<string>();
      for (const task of this.all().filter((t) => t.status === "queued")) {
        const key = botPrincipalKey(task.principal) + task.machineId;
        let claimed: FactoryTask | undefined;
        try {
          if (!checked.has(key)) {
            await this.probe(task.principal, task.machineId);
            if (this.closed) return;
            checked.add(key);
          }
          const current = this.machine(task.principal, task.machineId);
          if (
            !current.botIds.includes(task.botId) ||
            !current.repositories.some(
              (r) =>
                r.id === task.repositoryId && r.path === task.repositoryPath,
            )
          )
            throw new AuthorizationError(
              "Task configuration is no longer authorized",
            );
          claimed = this.claim(task.id);
        } catch (error) {
          if (this.closed) return;
          if (!(
            error instanceof NotFoundError ||
            error instanceof AuthorizationError
          ))
            throw error;
          this.acceptReport(task.id, {
            status: "failed",
            seq: task.seq + 1,
            finished: true,
            error:
              "Machine configuration or permission changed before execution",
          });
          continue;
        }
        if (!claimed) continue;
        this.track(
          this.transport.start(claimed.machine, claimed).then(
            (r) => {
              this.acceptReport(claimed.id, r);
            },
            () => {
              if (!this.closed) this.unknown(claimed.id);
            },
          ),
        );
      }
      if (this.closed) return;
      for (const cfg of this.configs()) {
        const state = this.patrolState(cfg.owner);
        const hour = new Date(this.clock()).toISOString().slice(0, 13);
        if (cfg.patrol.enabled && state.lastRunAt?.slice(0, 13) !== hour)
          await this.patrol(cfg.owner);
        if (this.closed) return;
      }
      this.flushOutbox();
    } finally {
      this.ticking = false;
    }
  }
  cancel(p: BotPrincipal, id: string) {
    return this.tx(() => {
      const t = this.get(p, id);
      if (t.status !== "queued")
        throw new ConflictError(
          "Only queued work can be cancelled; verify remote execution first",
        );
      t.status = "cancelled";
      t.updatedAt = this.now();
      t.finishedAt = t.updatedAt;
      t.history.push({ status: t.status, at: t.updatedAt });
      this.write(t);
      return t;
    });
  }
  private outbox(
    t: Pick<FactoryTask, "principal" | "roomId" | "coordinatorBotId">,
    key: string,
    body: string,
  ) {
    if (!t.roomId) return;
    this.host.store.db
      .prepare(
        "INSERT OR IGNORE INTO factory_outbox(key,principal,room_id,bot_id,body) VALUES(?,?,?,?,?)",
      )
      .run(
        key,
        JSON.stringify(t.principal),
        t.roomId,
        t.coordinatorBotId,
        body.slice(0, 16000),
      );
  }
  flushOutbox() {
    if (this.closed || !this.host.store.db.isOpen) return;
    for (const row of this.host.store.db
      .prepare("SELECT * FROM factory_outbox WHERE sent=0")
      .all() as {
      key: string;
      principal: string;
      room_id: string;
      bot_id: string;
      body: string;
    }[]) {
      const result = deliverBotRoomMessage(this.host.store, {
        roomId: row.room_id,
        botId: row.bot_id,
        principal: JSON.parse(row.principal),
        text: row.body,
        idempotencyKey: row.key,
      });
      if (result.delivered)
        this.host.store.db
          .prepare("UPDATE factory_outbox SET sent=1 WHERE key=?")
          .run(row.key);
    }
  }
  setPatrol(p: BotPrincipal, enabled: boolean) {
    if (typeof enabled !== "boolean")
      throw new ValidationError("enabled must be boolean");
    const c = this.settings(p);
    if (!c.roomId) throw new ValidationError("Configure factory first");
    c.patrol.enabled = enabled;
    this.host.store.setDaemonControl(this.key(p), c);
    return c.patrol;
  }
  patrolState(p: BotPrincipal): PatrolState {
    return (
      this.host.store.getDaemonControl<PatrolState>(
        "factory.patrol:" + botPrincipalKey(p),
      ) ?? { checks: {}, notified: {} }
    );
  }
  async patrol(p: BotPrincipal) {
    const tasks = this.list(p).filter((t) => !TERMINAL.has(t.status)),
      state = this.patrolState(p),
      cfg = this.settings(p);
    const fingerprint = JSON.stringify(
      tasks.map((t) => [t.id, t.status, t.updatedAt]),
    );
    const stale = tasks.filter(
      (t) =>
        ["running", "unknown"].includes(t.status) &&
        this.clock() - Date.parse(t.updatedAt) > 3600000,
    );
    if (tasks.length && (state.fingerprint !== fingerprint || stale.length))
      for (const t of stale) {
        let signals;
        try {
          signals = await this.transport.inspect(t.machine, t);
        } catch {
          signals = { process: null, fresh: null, commit: null, cpu: null };
        }
        if (this.closed) return state;
        const kind =
          signals.process === false && !signals.fresh
            ? "stuck"
            : signals.process === null
              ? "unknown"
              : "active";
        state.checks[t.id] = { signals, at: this.now(), kind };
        const key = "patrol:" + t.id + ":" + kind;
        if (kind !== "active" && !state.notified[key]) {
          this.outbox(
            t,
            key,
            `[factory] @${this.host.store.getBot(t.botId)?.name ?? t.botId} 请确认 ${t.id} 是否仍在推进；${kind === "stuck" ? "已核实停滞" : "连接或执行待核实"}。`,
          );
          state.notified[key] = true;
        }
      }
    if (this.closed) return state;
    state.fingerprint = fingerprint;
    state.lastRunAt = this.now();
    this.host.store.setDaemonControl(
      "factory.patrol:" + botPrincipalKey(p),
      state,
    );
    this.flushOutbox();
    return state;
  }
  pilotEvidence(p: BotPrincipal) {
    return {
      at: this.now(),
      tasks: this.list(p)
        .filter((t) => t.status === "succeeded")
        .map((t) => ({
          id: t.id,
          machineId: t.machineId,
          identity: t.identity,
          repositoryPath: t.repositoryPath,
          result: t.result,
          history: t.history,
        })),
    };
  }
  async close() {
    this.closed = true;
    await this.transport.close?.();
    await this.tickPromise?.catch(() => {});
  }
}
