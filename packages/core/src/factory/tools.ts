import type { ToolContract } from "../types.js";
import { AuthorizationError, ValidationError } from "../errors.js";
import { principalFromSession } from "../bots/bot-identity.js";
import { readApprovalWake } from "../approval/unattended-approval.js";
import type { SqliteStateStore } from "../storage.js";
import type { BotRoomService } from "../rooms/index.js";
import type { FactoryService } from "./service.js";
export function createFactoryTools(
  store: SqliteStateStore,
  rooms: BotRoomService,
  factory: FactoryService,
): ToolContract<any>[] {
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
  ];
}
