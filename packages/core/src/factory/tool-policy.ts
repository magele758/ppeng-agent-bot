import type { SessionRecord } from "../types.js";
import type { WebSettingsReadStore } from "../tools/web-settings.js";
import type { FactorySettings } from "./types.js";

/** Operations `factory_dispatch` may submit. Any other value is an arbitrary remote command. */
const FACTORY_READONLY_DISPATCH_OPS = [
  "snapshot",
  "count-files",
  "read-log",
] as const;

const COORDINATOR_FACTORY_TOOLS = new Set([
  'goal_dispatch',
  'goal_checkpoint',
  "factory_status",
  "factory_dispatch",
  "factory_settings_save",
  "factory_patrol_set",
  "factory_list_repos",
]);

const DISPATCH_COMMAND_FIELDS = new Set([
  "command",
  "argv",
  "shell",
  "script",
  "remoteCommand",
  "cmd",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isReadonlyDispatchEnum(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== FACTORY_READONLY_DISPATCH_OPS.length
  ) {
    return false;
  }
  const seen = new Set(value);
  return FACTORY_READONLY_DISPATCH_OPS.every((op) => seen.has(op));
}

/** Keep the shared tool object when it already exposes only the read-only ops. */
function sealReadonlyDispatch<T extends { name: string }>(tool: T): T {
  const schema = (tool as { inputSchema?: unknown }).inputSchema;
  if (!isRecord(schema)) return tool;
  const sourceProperties = isRecord(schema.properties) ? schema.properties : {};
  const properties: Record<string, unknown> = {};
  let removedCommand = false;
  for (const [key, value] of Object.entries(sourceProperties)) {
    if (DISPATCH_COMMAND_FIELDS.has(key)) {
      removedCommand = true;
      continue;
    }
    properties[key] = value;
  }
  const current = properties.operation;
  const enumSealed = isReadonlyDispatchEnum(
    isRecord(current) ? current.enum : undefined,
  );
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (name) => typeof name !== "string" || !DISPATCH_COMMAND_FIELDS.has(name),
      )
    : undefined;
  const requiredChanged =
    Array.isArray(schema.required) &&
    required !== undefined &&
    required.length !== schema.required.length;
  const hasCombinator =
    schema.oneOf !== undefined ||
    schema.anyOf !== undefined ||
    schema.allOf !== undefined;
  if (!removedCommand && enumSealed && !requiredChanged && !hasCombinator) {
    return tool;
  }
  properties.operation = {
    ...(isRecord(current) ? current : { type: "string" }),
    type: "string",
    enum: [...FACTORY_READONLY_DISPATCH_OPS],
  };
  const nextSchema: Record<string, unknown> = { ...schema, properties };
  if (required) nextSchema.required = required;
  delete nextSchema.oneOf;
  delete nextSchema.anyOf;
  delete nextSchema.allOf;
  return { ...tool, inputSchema: nextSchema };
}

/** Apply after dynamic tool expansion too: a read-only pilot has no shell escape. */
export function filterFactoryTools<T extends { name: string }>(
  session: Pick<SessionRecord, "metadata">,
  tools: T[],
  store?: WebSettingsReadStore,
): T[] {
  const meta = session.metadata ?? {};
  const userId =
    typeof meta.userId === "string" && meta.userId.trim()
      ? meta.userId.trim()
      : (store?.getDaemonControl?.("bot.installationPrincipal") as
          string | undefined);
  if (!userId) return tools;
  const tenantId =
    typeof meta.userId === "string" && typeof meta.tenantId === "string"
      ? meta.tenantId
      : "";
  const cfg = store?.getDaemonControl?.(
    "factory.settings:" + JSON.stringify([tenantId, userId]),
  ) as FactorySettings | undefined;
  if (!cfg?.roomId) return tools;
  const botId = meta.botId;
  const bound =
    botId === cfg.coordinatorBotId ||
    cfg.machines.some((m) => m.botIds.includes(String(botId)));
  if (!bound && meta.roomId !== cfg.roomId) return tools;
  const coordinator = botId === cfg.coordinatorBotId;
  const developmentAuthorized = coordinator && cfg.machines.some(machine => machine.allowedUserIds?.includes(userId) && machine.repositories?.some(repo => {
    const policy=store?.getDaemonControl?.('factory.development:'+JSON.stringify([tenantId,userId])+':'+machine.id+':'+repo.id) as {enabled?:boolean;criteriaApproved?:boolean;allowedUserIds?:string[]}|undefined;
    return policy?.enabled===true && policy.criteriaApproved===true && policy.allowedUserIds?.includes(userId);
  }));
  const kept: T[] = [];
  for (const tool of tools) {
    if (tool.name === 'goal_factory_develop' && developmentAuthorized) { kept.push(tool); continue; }
    if (tool.name === "factory_status") {
      kept.push(tool);
      continue;
    }
    if (!coordinator || !COORDINATOR_FACTORY_TOOLS.has(tool.name)) continue;
    kept.push(
      tool.name === "factory_dispatch" ? sealReadonlyDispatch(tool) : tool,
    );
  }
  return kept;
}
