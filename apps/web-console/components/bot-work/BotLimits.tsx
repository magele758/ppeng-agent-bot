"use client";
import { useEffect, useState } from "react";
import { pauseChange, shownPause, type PauseControl } from "@/lib/bot-panel-reset";
import { useI18n } from "@/lib/i18n";
import { api, json, useAction, Feedback } from "./shared";
import { useBotPanelRead } from "./use-bot-panel-read";
export function BotLimits() {
  const { t } = useI18n();
  const action = useAction();
  const [context, setContext] = useState(131072);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [perBot, setPerBot] = useState(1000);
  const [perPrincipal, setPerPrincipal] = useState(10000);
  useEffect(() => {
    void action.run(async () => {
      const [window, queue] = (await Promise.all([
        api("/api/bot-context-settings"),
        api("/api/bot-work/settings"),
      ])) as [
        { settings: { fallbackContextTokens: number } },
        { settings: { perBot: number; perPrincipal: number } },
      ];
      setContext(window.settings.fallbackContextTokens);
      setPerBot(queue.settings.perBot);
      setPerPrincipal(queue.settings.perPrincipal);
      setLoaded(true);
    });
  }, []);
  return (
    <section className="ag-panel" data-testid="bot-global-limits">
      <h3>{t("botWork.globalLimits")}</h3>
      <p>{t("botWork.globalLimitsHint")}</p>
      <Feedback {...action} />
      {saved && !action.busy && !action.error && <p role="status">{t("botWork.limitsSaved")}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          void action.run(async () => {
            await api(
              "/api/bot-context-settings",
              json({ fallbackContextTokens: context }, "PATCH"),
            );
            await api("/api/bot-work/settings", json({ perBot, perPrincipal }));
            setSaved(true);
          });
        }}
      >
        <label>
          {t("botWork.fallbackWindow")}
          <input
            type="number"
            min={1024}
            required
            value={context}
            onChange={(e) => setContext(Number(e.target.value))}
          />
        </label>
        <label>
          {t("botWork.queuePerBot")}
          <input
            type="number"
            min={1}
            max={100000}
            required
            value={perBot}
            onChange={(e) => setPerBot(Number(e.target.value))}
          />
        </label>
        <label>
          {t("botWork.queuePerPrincipal")}
          <input
            type="number"
            min={1}
            max={100000}
            required
            value={perPrincipal}
            onChange={(e) => setPerPrincipal(Number(e.target.value))}
          />
        </label>
        <button disabled={action.busy || !loaded}>{t("botWork.save")}</button>
      </form>
    </section>
  );
}

export function BotRuntimeControl({ botId }: { botId: string }) {
  const { t } = useI18n();
  const action = useAction();
  const panel = useBotPanelRead(botId);
  const [loadedBotId, setLoadedBotId] = useState("");
  const [control, setControl] = useState<PauseControl>({ paused: false, disabled: false });
  const visible = shownPause(botId, loadedBotId, control);
  const loaded = botId === loadedBotId;
  const apply = async (requestedBotId: string, next: PauseControl | null, signal?: AbortSignal) => {
    const data = await panel.read(
      requestedBotId,
      () =>
        api(
          `/api/bot-work/bots/${encodeURIComponent(requestedBotId)}/control`,
          next ? json(next) : { signal },
        ) as Promise<{ control: PauseControl }>,
      signal,
    );
    if (!data) return;
    setLoadedBotId(requestedBotId);
    setControl(data.control);
  };
  useEffect(() => {
    const ac = new AbortController();
    void action.run(() => apply(botId, null, ac.signal));
    return () => ac.abort();
  }, [botId]);
  const save = (patch: { botId: string; control: PauseControl } | null) => {
    if (!patch) return;
    void action.run(() => apply(patch.botId, patch.control));
  };
  return (
    <div>
      <Feedback {...action} />
      <label>
        <input
          type="checkbox"
          disabled={action.busy || !loaded}
          checked={visible.paused}
          onChange={(e) =>
            save(pauseChange({ selectedBotId: botId, loadedBotId, control, paused: e.target.checked }))
          }
        />
        {t("botWork.pauseBackground")}
      </label>
      <label>
        <input
          type="checkbox"
          disabled={action.busy || !loaded}
          checked={visible.disabled}
          onChange={(e) =>
            save(pauseChange({ selectedBotId: botId, loadedBotId, control, disabled: e.target.checked }))
          }
        />
        {t("botWork.disableBot")}
      </label>
    </div>
  );
}
