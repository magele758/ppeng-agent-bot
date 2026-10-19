import type { SessionRecord, ToolContract, ToolExecutionResult } from "../types.js";
import { AppError, AuthorizationError, NotFoundError, ValidationError } from "../errors.js";
import {
  principalFromSession,
  resolveBotPrincipal,
  sameBotPrincipal,
  type BotPrincipal,
} from "../bots/bot-identity.js";
import { ensureSuperBot } from "../bots/bot-work.js";
import { readApprovalWake } from "../approval/unattended-approval.js";
import type { Logger } from "../logger.js";
import type { SqliteStateStore } from "../storage.js";
import type { BotRoomService } from "../rooms/index.js";
import type { FactoryService } from "./service.js";

const ADMIN_ROLES = new Set(["owner", "admin"]);
const IDENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
// discover.ts is added on another branch. A top-level import would stop every
// factory tool from loading until that file exists, so the listing call loads it.
const DISCOVER_SPECIFIER: string = "./discover.js";
const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface FactoryToolDeps {
  listGitCheckouts?: (sshAlias: string) => Promise<readonly string[]>;
}

class RepoChoice extends ValidationError {
  constructor(readonly paths: readonly string[]) {
    super(paths.length === 0 ? "Repository path was not found" : "Repository path is ambiguous");
  }
}

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError("Invalid factory value");
  }
  return value.trim();
}

function identifier(value: unknown): string {
  const parsed = text(value, 80);
  if (!IDENT.test(parsed)) throw new ValidationError("Invalid identifier");
  return parsed;
}

function absolutePath(value: unknown): string {
  const parsed = text(value, 2048);
  if (!parsed.startsWith("/") || /[\u0000-\u001f]/.test(parsed)) {
    throw new ValidationError("Absolute repository path required");
  }
  return parsed;
}

function denied(): ToolExecutionResult {
  return { ok: false, content: JSON.stringify({ error: "admin_required", message: "没有权限" }) };
}

function failed(error: unknown): ToolExecutionResult {
  if (error instanceof RepoChoice) {
    return {
      ok: false,
      content: JSON.stringify({
        error: "repository_choice",
        message: error.message,
        paths: error.paths,
      }),
    };
  }
  if (error instanceof AuthorizationError) return denied();
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof AppError ? error.code : "ERROR";
  return { ok: false, content: JSON.stringify({ error: code, message }) };
}

function liveSession(store: SqliteStateStore, session: SessionRecord): SessionRecord {
  return store.getSession(session.id) ?? session;
}

/** Installation principal, or a tenant owner/admin. Never another person's row. */
function canWriteFactorySettings(store: SqliteStateStore, principal: BotPrincipal): boolean {
  if (sameBotPrincipal(principal, resolveBotPrincipal(store))) return true;
  if (!principal.tenantId) return false;
  return store.agentMemory().getMemberships(principal.userId).some(
    (membership) => membership.tenantId === principal.tenantId && ADMIN_ROLES.has(membership.role),
  );
}

function assertSettingsWritable(session: SessionRecord): void {
  if (session.metadata?.permissionMode === "plan") {
    throw new ValidationError("Factory settings are blocked in plan mode");
  }
}

function assertHumanSetup(store: SqliteStateStore, rooms: BotRoomService, session: SessionRecord): void {
  if (session.mode === 'subagent') throw new AuthorizationError('Delegated children cannot configure the factory');
  const principal = principalFromSession(store, session);
  if (typeof session.metadata.roomId === 'string') {
    const turn = rooms.turns(principal, session.metadata.roomId).find(
      item => item.currentSessionId === session.id && item.status === 'running',
    );
    if (!turn) throw new AuthorizationError('Active human room request required');
    return;
  }
  if (readApprovalWake(session.metadata)?.kind !== 'human') throw new AuthorizationError('Explicit human request required');
  const message = store.listMessages(session.id).filter(item => item.role === 'user').at(-1);
  if (!message || session.metadata.relayHopMessageId === message.id) throw new AuthorizationError('Explicit human request required');
}

function resolveBotId(store: SqliteStateStore, ref: unknown): string {
  const name = typeof ref === "string" ? ref.trim() : "";
  if (!name) throw new ValidationError("Unknown Bot");
  const hit = store.listBots({ includeHidden: true }).find((bot) => bot.id === name || bot.name === name);
  if (!hit) throw new ValidationError("Unknown Bot");
  return hit.id;
}

function coordinatorId(store: SqliteStateStore, principal: BotPrincipal, requested: unknown): string {
  if (typeof requested === "string" && requested.trim()) return resolveBotId(store, requested);
  return ensureSuperBot(
    { store, runSession: async () => undefined, log: quietLog },
    principal,
  ).bot.id;
}

function allowedIds(value: unknown, userId: string): string[] {
  if (!Array.isArray(value)) return [userId];
  const ids = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  return ids.length ? ids : [userId];
}

function capacityOf(value: unknown): number {
  if (value === undefined) return 2;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 20) {
    throw new ValidationError("Capacity must be 0–20");
  }
  return Number(value);
}

function parseLogs(value: unknown): { id: string; path: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) throw new ValidationError("Invalid logs");
  const ids = new Set<string>();
  return value.map((log) => {
    if (!isObj(log)) throw new ValidationError("Invalid log");
    const id = identifier(log.id);
    if (ids.has(id)) throw new ValidationError("Duplicate log");
    ids.add(id);
    return { id, path: absolutePath(log.path) };
  });
}

function parseRepositories(value: unknown): { id: string; path: string; logs?: { id: string; path: string }[] }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) throw new ValidationError("Invalid repositories");
  const ids = new Set<string>();
  return value.map((repo) => {
    if (!isObj(repo)) throw new ValidationError("Invalid repository");
    const id = identifier(repo.id);
    if (ids.has(id)) throw new ValidationError("Duplicate repository");
    ids.add(id);
    const logs = parseLogs(repo.logs);
    return { id, path: absolutePath(repo.path), ...(logs ? { logs } : {}) };
  });
}

async function listGitCheckouts(sshAlias: string): Promise<string[]> {
  let loaded: { listGitCheckouts?: (alias: string) => Promise<readonly string[]> };
  try {
    loaded = await import(DISCOVER_SPECIFIER);
  } catch {
    throw new ValidationError("Repository discovery is unavailable");
  }
  if (typeof loaded.listGitCheckouts !== "function") {
    throw new ValidationError("Repository discovery is unavailable");
  }
  const paths = await loaded.listGitCheckouts(sshAlias);
  if (!Array.isArray(paths) || paths.some((item) => typeof item !== "string")) {
    throw new ValidationError("Invalid repository listing");
  }
  return [...paths];
}

async function repositoriesFor(
  raw: Record<string, unknown>,
  sshAlias: string,
  list: (alias: string) => Promise<readonly string[]>,
): Promise<{ id: string; path: string; logs?: { id: string; path: string }[] }[]> {
  const given = parseRepositories(raw.repositories);
  if (raw.fillRepository !== true || (given && given.length > 0)) return given ?? [];
  const paths = [...await list(sshAlias)];
  const only = paths.length === 1 ? paths[0] : undefined;
  if (!only) throw new RepoChoice(paths);
  const id = raw.repositoryId === undefined ? "repo" : identifier(raw.repositoryId);
  return [{ id, path: absolutePath(only) }];
}

async function machineFrom(
  store: SqliteStateStore,
  principal: BotPrincipal,
  raw: unknown,
  list: (alias: string) => Promise<readonly string[]>,
) {
  if (!isObj(raw)) throw new ValidationError("Invalid machine");
  const sshAlias = identifier(raw.sshAlias);
  const botIds = raw.botIds === undefined ? [] : stringList(raw.botIds).map((ref) => resolveBotId(store, ref));
  return {
    id: raw.id === undefined ? sshAlias : identifier(raw.id),
    name: raw.name === undefined ? sshAlias : text(raw.name),
    sshAlias,
    capacity: capacityOf(raw.capacity),
    botIds,
    allowedUserIds: allowedIds(raw.allowedUserIds, principal.userId),
    repositories: await repositoriesFor(raw, sshAlias, list),
  };
}

function stringList(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100) throw new ValidationError("Expected list");
  return value;
}

function roomFor(
  rooms: BotRoomService,
  principal: BotPrincipal,
  requested: unknown,
  previousRoomId: string,
  coordinator: string,
  memberIds: string[],
  title: unknown,
): string {
  const existingId = typeof requested === "string" && requested.trim()
    ? requested.trim()
    : previousRoomId;
  if (existingId) {
    try {
      const room = rooms.get(principal, existingId);
      if (!room.botIds.includes(coordinator)) rooms.addMember(principal, room.id, coordinator);
      return room.id;
    } catch (error) {
      if (typeof requested === "string" && requested.trim()) throw error;
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  const roomTitle = typeof title === "string" && title.trim() ? title.trim() : "Factory";
  const created = rooms.create(principal, {
    title: roomTitle,
    botIds: [...new Set([coordinator, ...memberIds])],
    hostBotId: coordinator,
  });
  return created.id;
}

export function createFactoryTools(
  store: SqliteStateStore,
  rooms: BotRoomService,
  factory: FactoryService,
  deps: FactoryToolDeps = {},
): ToolContract<any>[] {
  const listCheckouts = deps.listGitCheckouts ?? listGitCheckouts;
  return [
    {
      name: "factory_dispatch",
      description:
        "Dispatch ONE authorized read-only factory task to a configured machine. Only snapshot, count-files and configured read-log are supported. Call only for an explicit human request. Returns durable task ID, not completion. Discover IDs using factory_status. Never run arbitrary shell commands.",
      approvalMode: "never",
      sideEffectLevel: "none",
      inputSchema: {
        type: "object",
        properties: {
          machineId: { type: "string" },
          repositoryId: { type: "string" },
          operation: {
            type: "string",
            enum: ["snapshot", "count-files", "read-log"],
          },
          logId: { type: "string" },
          requestKey: { type: "string" },
        },
        required: ["machineId", "repositoryId", "operation"],
      },
      async execute(ctx, args) {
        try {
          const session = store.getSession(ctx.session.id) ?? ctx.session;
          if (ctx.session.metadata.botId !== session.metadata.botId)
            throw new AuthorizationError("Factory Bot identity mismatch");
          if (session.metadata.permissionMode === "plan")
            throw new ValidationError("Factory dispatch blocked in plan mode");
          const p = principalFromSession(store, session),
            cfg = factory.settings(p),
            roomId = session.metadata.roomId;
          if (session.metadata.botId !== cfg.coordinatorBotId)
            throw new AuthorizationError(
              "Only configured coordinator dispatches factory work",
            );
          let key: string;
          if (typeof roomId === "string") {
            if (roomId !== cfg.roomId)
              throw new AuthorizationError("Factory room mismatch");
            const turn = rooms
              .turns(p, roomId)
              .find(
                (t) =>
                  t.currentSessionId === session.id &&
                  t.status === "running",
              );
            if (!turn)
              throw new AuthorizationError("No active human room request");
            key = "room:" + roomId + ":" + turn.messageId;
          } else {
            // Bot relays, routines and scheduler messages also use role=user.
            // Trust the intake wake provenance, never the transcript role alone.
            if (readApprovalWake(session.metadata)?.kind !== "human")
              throw new AuthorizationError("Explicit human request required");
            const message = store
              .listMessages(session.id)
              .filter((m) => m.role === "user")
              .at(-1);
            if (!message)
              throw new AuthorizationError("Human request required");
            if (session.metadata.relayHopMessageId === message.id)
              throw new AuthorizationError("Bot relay cannot authorize factory dispatch");
            key = "chat:" + session.id + ":" + message.id;
          }
          const task = factory.submit(p, {
            machineId: args.machineId,
            repositoryId: args.repositoryId,
            operation: args.operation,
            ...(args.logId ? { logId: args.logId } : {}),
            requestKey: key,
            roomId: cfg.roomId,
          });
          void factory.tick().catch(() => {});
          return { ok: true, content: JSON.stringify(task) };
        } catch (e) {
          return { ok: false, content: String(e) };
        }
      },
    },
    {
      name: "factory_status",
      description:
        "Read configured machines, capacity and durable factory task progress. Does not dispatch or execute anything.",
      approvalMode: "never",
      sideEffectLevel: "none",
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" } },
      },
      async execute(ctx, args) {
        try {
          const p = principalFromSession(store, ctx.session);
          return {
            ok: true,
            content: JSON.stringify(
              args.taskId ? factory.get(p, args.taskId) : factory.board(p),
            ),
          };
        } catch (e) {
          return { ok: false, content: String(e) };
        }
      },
    },
    {
      name: "factory_settings_save",
      description:
        "Save multi-machine factory settings for the person in this chat, or for this installation when nobody is logged in. Never writes another person's row. Replaces the machine list. Defaults when omitted: coordinatorBotId is Super Bot and is added to the room, allowedUserIds is the chatting user, capacity is 2, and patrol stays off. When roomId is omitted and no factory room is saved, creates one through the room service. Set a machine's fillRepository true only when the user asked to fill its repository; exactly one git checkout path is stored, otherwise nothing is saved. Patrol does not change here.",
      approvalMode: "never",
      sideEffectLevel: "none",
      inputSchema: {
        type: "object",
        properties: {
          machines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                sshAlias: { type: "string" },
                capacity: { type: "number" },
                botIds: { type: "array", items: { type: "string" } },
                allowedUserIds: { type: "array", items: { type: "string" } },
                repositories: { type: "array" },
                fillRepository: { type: "boolean" },
                repositoryId: { type: "string" },
              },
              required: ["sshAlias"],
            },
          },
          roomId: { type: "string" },
          roomTitle: { type: "string" },
          coordinatorBotId: { type: "string" },
        },
        required: ["machines"],
      },
      async execute(ctx, args) {
        try {
          const session = liveSession(store, ctx.session);
          const principal = principalFromSession(store, session);
          if (!canWriteFactorySettings(store, principal)) return denied();
          assertSettingsWritable(session);
          assertHumanSetup(store, rooms, session);
          if (!isObj(args) || !Array.isArray(args.machines) || args.machines.length > 50) {
            throw new ValidationError("Invalid machines");
          }
          const machines: Awaited<ReturnType<typeof machineFrom>>[] = [];
          const seen = new Set<string>();
          for (const raw of args.machines) {
            const machine = await machineFrom(store, principal, raw, listCheckouts);
            if (seen.has(machine.id)) throw new ValidationError("Duplicate machine");
            seen.add(machine.id);
            machines.push(machine);
          }
          return store.transaction(() => {
            store.assertCurrentWriter(session.id);
            ctx.abortSignal?.throwIfAborted();
            const current = liveSession(store, session);
            if (!sameBotPrincipal(principalFromSession(store, current), principal) || !canWriteFactorySettings(store, principal)) return denied();
            assertSettingsWritable(current);
            assertHumanSetup(store, rooms, current);
            const previous = factory.settings(principal);
            const coordinator = coordinatorId(store, principal, args.coordinatorBotId);
            const roomId = roomFor(
              rooms,
              principal,
              args.roomId,
              previous.roomId,
              coordinator,
              machines.flatMap((machine) => machine.botIds),
              args.roomTitle,
            );
            const saved = factory.saveSettings(principal, { machines, roomId, coordinatorBotId: coordinator });
            return { ok: true, content: JSON.stringify(saved) };
          });
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "factory_patrol_set",
      description:
        "Turn factory patrol on or off for this chat's saved factory settings. Leave it off unless the user explicitly asks. Does not write another person's settings.",
      approvalMode: "never",
      sideEffectLevel: "none",
      inputSchema: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
      },
      async execute(ctx, args) {
        try {
          return store.transaction(() => {
            store.assertCurrentWriter(ctx.session.id);
            ctx.abortSignal?.throwIfAborted();
            const session = liveSession(store, ctx.session);
            const principal = principalFromSession(store, session);
            if (!canWriteFactorySettings(store, principal)) return denied();
            assertSettingsWritable(session);
            assertHumanSetup(store, rooms, session);
            const enabled = isObj(args) ? args.enabled : undefined;
            return { ok: true, content: JSON.stringify(factory.setPatrol(principal, enabled as boolean)) };
          });
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "factory_list_repos",
      description:
        "List absolute git checkout paths on one saved factory machine via listGitCheckouts and that machine's SSH alias. Does not run any other remote command, does not accept a different alias, and does not change settings. When the user asks to store the single path, call factory_settings_save with fillRepository true.",
      approvalMode: "never",
      sideEffectLevel: "none",
      inputSchema: {
        type: "object",
        properties: {
          machineId: { type: "string" },
          sshAlias: { type: "string" },
        },
        required: ["machineId"],
      },
      async execute(ctx, args) {
        try {
          const session = liveSession(store, ctx.session);
          const principal = principalFromSession(store, session);
          if (!isObj(args)) throw new ValidationError("Invalid machine");
          const machineId = identifier(args.machineId);
          const machine = factory.settings(principal).machines.find((item) => item.id === machineId);
          if (!machine) throw new NotFoundError("Machine", machineId);
          if (!machine.allowedUserIds.includes(principal.userId)) return denied();
          if (typeof args.sshAlias === "string" && args.sshAlias.trim() && args.sshAlias.trim() !== machine.sshAlias) {
            throw new ValidationError("SSH alias does not match the saved machine");
          }
          const paths = [...await listCheckouts(machine.sshAlias)];
          return { ok: true, content: JSON.stringify({ machineId, sshAlias: machine.sshAlias, paths }) };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
}
