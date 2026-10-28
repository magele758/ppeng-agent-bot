import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SqliteStateStore } from "../storage.js";
import type { RunContext, ToolContract } from "../types.js";
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from "../errors.js";
import { SecretVault } from "../secrets/secret-vault.js";
import {
  principalFromSession,
  botPrincipalKey,
  type BotPrincipal,
} from "../bots/bot-identity.js";
import {
  privateAddress,
  readHttpResponse,
} from "../connectors/software-execution.js";
import { requestApprovedAddress } from "../connectors/http-request.js";
import { fenceExternalContent } from "../safety/external-content.js";

const KEY = "external_agent_connections_v1";
type Target = { kind: "bot" | "agent"; id: string };
interface Connection {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  target: Target;
  allowedBotIds: string[];
  allowPrivateNetwork: boolean;
  principal: BotPrincipal;
  credentialRef: string;
  revision: string;
}
interface RemoteTask {
  id: string;
  status: string;
  result?: string | null;
  reason?: string;
  progress?: unknown[];
  artifacts?: unknown[];
}
interface Delegation {
  id: string;
  connectionId: string;
  revision: string;
  principal: string;
  botId: string;
  sourceTaskId: string;
  payload: {
    source: string;
    sourceTaskId: string;
    goal: string;
    context?: string;
    botId?: string;
    agentId?: string;
  };
  status: string;
  error?: string;
  remoteTaskId?: string;
  task?: RemoteTask;
  createdAt: string;
  updatedAt: string;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("Expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ValidationError(`Invalid ${field}`);
  return value.trim();
}
function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(`Invalid ${field}`);
  return value;
}
function endpoint(value: unknown): string {
  let url: URL;
  try {
    url = new URL(text(value, "baseUrl", 2000));
  } catch {
    throw new ValidationError("Invalid remote URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ValidationError(
      "Use an HTTP(S) origin without credentials, path, query or fragment",
    );
  return url.origin;
}
function taskResponse(value: unknown): RemoteTask {
  const raw = object(object(value).task);
  const status = text(raw.status, "task.status", 50);
  if (
    ![
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "waiting_input",
      "waiting_approval",
      "unknown",
    ].includes(status)
  )
    throw new ValidationError("Unsupported remote status");
  const id = text(raw.id, "task.id", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id))
    throw new ValidationError("Invalid remote task ID");
  if (
    raw.result !== undefined &&
    raw.result !== null &&
    typeof raw.result !== "string"
  )
    throw new ValidationError("Invalid remote result");
  return {
    id,
    status,
    ...(typeof raw.result === "string" || raw.result === null
      ? { result: raw.result }
      : {}),
    ...(typeof raw.reason === "string"
      ? { reason: raw.reason.slice(0, 2000) }
      : {}),
    ...(Array.isArray(raw.progress) ? { progress: raw.progress } : {}),
    ...(Array.isArray(raw.artifacts) ? { artifacts: raw.artifacts } : {}),
  };
}

/** Scoped task protocol client. Remote effects are tracked before network I/O and never inferred from dispatch. */
export class ExternalAgentConnections {
  private readonly active = new Map<string, Promise<Delegation>>();
  constructor(
    private readonly store: SqliteStateStore,
    private readonly authorizeBot: (
      id: string,
      principal: BotPrincipal,
    ) => void,
    private readonly vault: SecretVault = new SecretVault(store),
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS external_agent_delegations (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, connection_id TEXT NOT NULL, idem TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(scope,connection_id,idem))`);
  }
  private connections(): Connection[] {
    return this.store.getDaemonControl<Connection[]>(KEY) ?? [];
  }
  settings() {
    return {
      connections: this.connections().map(
        ({
          credentialRef: _credential,
          principal: _principal,
          revision: _revision,
          ...c
        }) => ({ ...c, tokenSet: true }),
      ),
    };
  }
  configure(input: unknown, principal: BotPrincipal) {
    const body = object(input);
    if (!Array.isArray(body.connections) || body.connections.length > 100)
      throw new ValidationError("connections must contain at most 100 entries");
    const old = this.connections();
    const ids = new Set<string>();
    const secrets: Array<{ name: string; value: string }> = [];
    const rows = body.connections.map((value) => {
      const raw = object(value),
        id = text(raw.id, "id", 80);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || ids.has(id))
        throw new ValidationError("Connection IDs must be unique");
      ids.add(id);
      const previous = old.find((c) => c.id === id);
      const owner = previous?.principal ?? principal;
      if (botPrincipalKey(owner) !== botPrincipalKey(principal))
        throw new AuthorizationError("Connection belongs to another principal");
      const target = object(raw.target),
        kind = target.kind;
      if (kind !== "bot" && kind !== "agent")
        throw new ValidationError("Choose a remote Bot or executor");
      if (
        !Array.isArray(raw.allowedBotIds) ||
        !raw.allowedBotIds.length ||
        raw.allowedBotIds.length > 100
      )
        throw new ValidationError("Select at least one local Bot");
      const allowedBotIds = [
        ...new Set(raw.allowedBotIds.map((id) => text(id, "allowedBotIds"))),
      ];
      for (const botId of allowedBotIds) this.authorizeBot(botId, owner);
      let credentialRef = previous?.credentialRef;
      if (raw.token !== undefined && raw.token !== "") {
        const value = text(raw.token, "token", 512);
        if (value.length < 32 || /[\r\n]/.test(value))
          throw new ValidationError(
            "Remote credential requires at least 32 characters and no line breaks",
          );
        credentialRef = `EXTERNAL_AGENT_${randomUUID().replaceAll("-", "_").toUpperCase()}`;
        secrets.push({ name: credentialRef, value });
      }
      if (!credentialRef)
        throw new ValidationError("Remote credential required");
      const baseUrl = endpoint(raw.baseUrl);
      const targetValue: Target = { kind, id: text(target.id, "target.id") };
      // A grant-only edit or credential rotation must not orphan accepted work. A target change does.
      const revision = createHash("sha256")
        .update(JSON.stringify([id, baseUrl, targetValue]))
        .digest("hex");
      return {
        id,
        name: text(raw.name, "name"),
        baseUrl,
        target: targetValue,
        enabled: bool(raw.enabled, "enabled"),
        allowedBotIds,
        allowPrivateNetwork: bool(
          raw.allowPrivateNetwork ?? false,
          "allowPrivateNetwork",
        ),
        principal: owner,
        credentialRef,
        revision,
      } satisfies Connection;
    });
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const vault = this.vault;
      for (const secret of secrets) vault.set(secret.name, secret.value);
      this.store.setDaemonControl(KEY, rows);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return this.settings();
  }
  private identity(ctx: RunContext) {
    const botId = text(ctx.session.metadata?.botId, "Bot identity");
    const principal = principalFromSession(this.store, ctx.session);
    this.authorizeBot(botId, principal);
    return {
      botId,
      principal,
      scope: JSON.stringify([botPrincipalKey(principal), botId]),
    };
  }
  private connection(ctx: RunContext, id: string): Connection {
    const who = this.identity(ctx);
    const c = this.connections().find(
      (c) =>
        c.id === id &&
        c.enabled &&
        c.allowedBotIds.includes(who.botId) &&
        botPrincipalKey(c.principal) === botPrincipalKey(who.principal),
    );
    if (!c)
      throw new AuthorizationError(
        "External Agent connection is not granted for this Bot",
      );
    return c;
  }
  private save(row: Delegation) {
    row.updatedAt = new Date().toISOString();
    this.store.db
      .prepare("UPDATE external_agent_delegations SET payload=? WHERE id=?")
      .run(JSON.stringify(row), row.id);
    return row;
  }
  private read(id: string): Delegation | undefined {
    const row = this.store.db
      .prepare("SELECT payload FROM external_agent_delegations WHERE id=?")
      .get(id);
    return row ? (JSON.parse(String(row.payload)) as Delegation) : undefined;
  }
  private owned(
    ctx: RunContext,
    id: string,
  ): { row: Delegation; connection: Connection } {
    const who = this.identity(ctx),
      row = this.read(id);
    if (
      !row ||
      row.botId !== who.botId ||
      row.principal !== botPrincipalKey(who.principal)
    )
      throw new NotFoundError("External task");
    const connection = this.connection(ctx, row.connectionId);
    if (connection.revision !== row.revision)
      throw new ValidationError(
        "Remote target changed; restore the original connection to access this task",
      );
    return { row, connection };
  }
  list(ctx: RunContext) {
    const who = this.identity(ctx);
    return {
      connections: this.settings().connections.filter((c) => {
        try {
          this.connection(ctx, c.id);
          return true;
        } catch {
          return false;
        }
      }),
      tasks: this.store.db
        .prepare(
          "SELECT payload FROM external_agent_delegations WHERE scope=? ORDER BY rowid DESC LIMIT 100",
        )
        .all(who.scope)
        .map((r) => JSON.parse(String(r.payload)) as Delegation),
    };
  }
  private async request(
    ctx: RunContext,
    c: Connection,
    path: string,
    body?: unknown,
  ): Promise<RemoteTask> {
    const url = new URL(path, c.baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true });
    // Recheck the live grant and network policy after DNS before dispatch.
    const live = this.connection(ctx, c.id);
    if (
      !addresses.length ||
      (!live.allowPrivateNetwork &&
        addresses.some((a) => privateAddress(a.address)))
    )
      throw new ValidationError("Private address denied by network policy");

    if (live.revision !== c.revision)
      throw new AuthorizationError("Connection target changed");
    const secret = new SecretVault(this.store).get(live.credentialRef);
    if (!secret) throw new ValidationError("Remote credential unavailable");
    const signal = ctx.abortSignal
      ? AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    try {
      const response = await requestApprovedAddress(
        url,
        addresses[0]!.address,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new ValidationError(`Remote Agent HTTP ${response.status}`);
      }
      const raw = await readHttpResponse(response, 1000000);
      const parsed: unknown = JSON.parse(raw, (_key, value: unknown) =>
        typeof value === "string"
          ? value.replaceAll(secret, "[REDACTED]")
          : value,
      );
      return taskResponse(parsed);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError(
        "Remote Agent request failed; check connection, authorization and task state",
      );
    }
  }
  async delegate(ctx: RunContext, input: unknown): Promise<Delegation> {
    if (ctx.session.metadata?.permissionMode === "plan")
      throw new AuthorizationError("Delegation blocked in plan mode");
    const args = object(input),
      who = this.identity(ctx),
      connection = this.connection(
        ctx,
        text(args.connectionId, "connectionId"),
      );
    const idem = text(args.idempotencyKey, "idempotencyKey", 256),
      goal = text(args.goal, "goal", 32000);
    const sourceTaskId = createHash("sha256")
      .update(
        JSON.stringify([who.scope, connection.id, connection.revision, idem]),
      )
      .digest("hex");
    const payload = {
      source: "ppeng-agent-bot",
      sourceTaskId,
      goal,
      ...(args.context === undefined
        ? {}
        : { context: text(args.context, "context", 64000) }),
      ...(connection.target.kind === "bot"
        ? { botId: connection.target.id }
        : { agentId: connection.target.id }),
    };
    const now = new Date().toISOString();
    const fresh: Delegation = {
      id: randomUUID(),
      connectionId: connection.id,
      revision: connection.revision,
      principal: botPrincipalKey(who.principal),
      botId: who.botId,
      sourceTaskId,
      payload,
      status: "unknown",
      createdAt: now,
      updatedAt: now,
    };
    this.store.db
      .prepare(
        "INSERT INTO external_agent_delegations(id,scope,connection_id,idem,payload) VALUES(?,?,?,?,?) ON CONFLICT(scope,connection_id,idem) DO NOTHING",
      )
      .run(fresh.id, who.scope, connection.id, idem, JSON.stringify(fresh));
    const stored = this.store.db
      .prepare(
        "SELECT id FROM external_agent_delegations WHERE scope=? AND connection_id=? AND idem=?",
      )
      .get(who.scope, connection.id, idem)!;
    const row = this.read(String(stored.id))!;
    if (
      row.revision !== connection.revision ||
      JSON.stringify(row.payload) !== JSON.stringify(payload)
    )
      throw new ValidationError(
        "Idempotency key already used with different arguments or target",
      );
    if (row.remoteTaskId) return row;
    const running = this.active.get(row.id);
    if (running) return running;
    const pending = (async () => {
      try {
        const task = await this.request(
          ctx,
          connection,
          "/api/external-agent/v1/tasks",
          row.payload,
        );
        row.remoteTaskId = task.id;
        row.task = task;
        row.status = task.status;
        delete row.error;
      } catch (error) {
        row.status = "unknown";
        row.error = error instanceof Error ? error.message : "Remote acceptance unknown";
      }
      return this.save(row);
    })();
    this.active.set(row.id, pending);
    try {
      return await pending;
    } finally {
      this.active.delete(row.id);
    }
  }
  async status(ctx: RunContext, id: string): Promise<Delegation> {
    const { row, connection } = this.owned(ctx, id);
    if (!row.remoteTaskId) return row;
    const task = await this.request(
      ctx,
      connection,
      `/api/external-agent/v1/tasks/${encodeURIComponent(row.remoteTaskId)}`,
    );
    if (task.id !== row.remoteTaskId)
      throw new ValidationError("Remote task ID mismatch");
    row.task = task;
    row.status = task.status;
    return this.save(row);
  }
  async action(
    ctx: RunContext,
    input: unknown,
    action: "cancel" | "input",
  ): Promise<Delegation> {
    if (ctx.session.metadata?.permissionMode === "plan")
      throw new AuthorizationError("Task changes blocked in plan mode");
    const args = object(input),
      { row, connection } = this.owned(ctx, text(args.taskId, "taskId"));
    if (!row.remoteTaskId)
      throw new ValidationError(
        "Acceptance unknown; retry delegation with its original idempotency key",
      );
    const body =
      action === "cancel"
        ? {}
        : {
            message: text(args.message, "message", 32000),
            inputId: text(args.inputId, "inputId", 256),
          };
    const task = await this.request(
      ctx,
      connection,
      `/api/external-agent/v1/tasks/${encodeURIComponent(row.remoteTaskId)}/${action}`,
      body,
    );
    if (task.id !== row.remoteTaskId)
      throw new ValidationError("Remote task ID mismatch");
    row.task = task;
    row.status = task.status;
    return this.save(row);
  }
  tools(): ToolContract[] {
    const schema = (
      properties: Record<string, unknown>,
      required: string[],
    ) => ({
      type: "object",
      properties,
      required,
      additionalProperties: false,
    });
    const str = { type: "string" };
    const specs = [
      {
        name: "external_agent_list",
        description:
          "List authorized external Agent connections and recent delegated tasks for this Bot.",
        inputSchema: schema({}, []),
        write: false,
        run: (ctx: RunContext) => this.list(ctx),
      },
      {
        name: "external_agent_delegate",
        description:
          "Delegate to a configured external Agent. Supply a stable idempotencyKey, goal and optional context. Returns a tracked local task ID; queued or unknown is not completion. Retry unknown acceptance with the SAME key and arguments.",
        inputSchema: schema(
          { connectionId: str, idempotencyKey: str, goal: str, context: str },
          ["connectionId", "idempotencyKey", "goal"],
        ),
        write: true,
        run: (ctx: RunContext, args: unknown) => this.delegate(ctx, args),
      },
      {
        name: "external_agent_status",
        description:
          "Query an external task by its local taskId. Read status, result and human-step requirements; never infer completion from dispatch.",
        inputSchema: schema({ taskId: str }, ["taskId"]),
        write: false,
        run: (ctx: RunContext, args: unknown) =>
          this.status(ctx, text(object(args).taskId, "taskId")),
      },
      {
        name: "external_agent_cancel",
        description:
          "Cancel an authorized external task. Requires a peer supporting cancellation.",
        inputSchema: schema({ taskId: str }, ["taskId"]),
        write: true,
        run: (ctx: RunContext, args: unknown) =>
          this.action(ctx, args, "cancel"),
      },
      {
        name: "external_agent_input",
        description:
          "Provide requested input to an external task waiting_input. Use a stable inputId when retrying. Does not approve tools.",
        inputSchema: schema({ taskId: str, message: str, inputId: str }, [
          "taskId",
          "message",
          "inputId",
        ]),
        write: true,
        run: (ctx: RunContext, args: unknown) =>
          this.action(ctx, args, "input"),
      },
    ];
    return specs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      approvalMode: "auto",
      sideEffectLevel: spec.write ? "system" : "none",
      needsApproval: () => spec.write,
      execute: async (ctx, args) => {
        try {
          return {
            ok: true,
            content: fenceExternalContent({
              source: "http",
              label: spec.name,
              body: JSON.stringify(await spec.run(ctx, args)),
            }),
          };
        } catch (error) {
          return {
            ok: false,
            content:
              error instanceof Error
                ? error.message
                : "External Agent operation failed",
          };
        }
      },
    }));
  }
}
