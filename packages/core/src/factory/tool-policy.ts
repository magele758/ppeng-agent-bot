import type { SessionRecord } from "../types.js";
import type { WebSettingsReadStore } from "../tools/web-settings.js";
import type { FactorySettings } from "./types.js";
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
  return tools.filter(
    (t) =>
      t.name === "factory_status" ||
      (t.name === "factory_dispatch" && botId === cfg.coordinatorBotId),
  );
}
