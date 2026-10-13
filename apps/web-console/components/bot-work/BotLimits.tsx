"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { api, json, useAction, Feedback } from "./shared";
export function BotLimits() {
  const { t } = useI18n();
  const action = useAction();
  const [context, setContext] = useState(32768);
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
    });
  }, []);
  return (
    <details>
      <summary>{t("botWork.limits")}</summary>
      <Feedback {...action} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(
              "/api/bot-context-settings",
              json({ fallbackContextTokens: context }, "PATCH"),
            );
            await api("/api/bot-work/settings", json({ perBot, perPrincipal }));
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
        <button disabled={action.busy}>{t("botWork.save")}</button>
      </form>
    </details>
  );
}

export function BotRuntimeControl({ botId }: { botId: string }) {
  const { t } = useI18n();
  const action = useAction();
  const [control, setControl] = useState({ paused: false, disabled: false });
  const path = `/api/bot-work/bots/${encodeURIComponent(botId)}/control`;
  useEffect(() => {
    void action.run(async () => {
      const data = (await api(path)) as { control: typeof control };
      setControl(data.control);
    });
  }, [botId]);
  const save = (next: typeof control) =>
    void action.run(async () => {
      const data = (await api(path, json(next))) as { control: typeof control };
      setControl(data.control);
    });
  return (
    <div>
      <Feedback {...action} />
      <label>
        <input
          type="checkbox"
          disabled={action.busy}
          checked={control.paused}
          onChange={(e) => save({ ...control, paused: e.target.checked })}
        />
        {t("botWork.pauseBackground")}
      </label>
      <label>
        <input
          type="checkbox"
          disabled={action.busy}
          checked={control.disabled}
          onChange={(e) => save({ ...control, disabled: e.target.checked })}
        />
        {t("botWork.disableBot")}
      </label>
    </div>
  );
}
