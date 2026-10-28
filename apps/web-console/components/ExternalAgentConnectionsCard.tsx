"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { SettingsGroup } from "./ui";
import {
  FieldRow,
  LoadGate,
  SaveBar,
  StatusLine,
  TextField,
  ToggleField,
} from "./sections/settings/categories/kit/fields";
import { useSettingsResource } from "./sections/settings/categories/kit/settings-store";
interface Connection {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  allowedBotIds: string[];
  target: { kind: "bot" | "agent"; id: string };
  allowPrivateNetwork: boolean;
  tokenSet: boolean;
}
interface Settings {
  connections: Connection[];
}
interface Draft extends Omit<Connection, "allowedBotIds"> {
  allowedBotIds: string;
  token: string;
  rowKey: string;
}
const PATH = "/api/external-agents/connections";
const draft = (c: Connection): Draft => ({
  ...c,
  allowedBotIds: c.allowedBotIds.join(", "),
  token: "",
  rowKey: c.id,
});
const payload = ({
  rowKey: _row,
  tokenSet: _set,
  token,
  allowedBotIds,
  ...c
}: Draft) => ({
  ...c,
  allowedBotIds: allowedBotIds.split(/[,\s]+/).filter(Boolean),
  ...(token.trim() ? { token: token.trim() } : {}),
});
export function ExternalAgentConnectionsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<Settings>(PATH);
  const [rows, setRows] = useState<Draft[]>([]);
  const [bots, setBots] = useState<string[]>([]);
  useEffect(() => {
    if (r.settings) setRows(r.settings.connections.map(draft));
  }, [r.settings]);
  useEffect(() => {
    let live = true;
    void api("/api/bots")
      .then((data) => {
        if (live)
          setBots((data as { bots: { id: string }[] }).bots.map((b) => b.id));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const edit = (rowKey: string, patch: Partial<Draft>) =>
    setRows((rows) =>
      rows.map((c) => (c.rowKey === rowKey ? { ...c, ...patch } : c)),
    );
  const reset = () => {
    if (r.settings) setRows(r.settings.connections.map(draft));
  };
  const dirty =
    r.settings !== null &&
    JSON.stringify(rows.map(payload)) !==
      JSON.stringify(r.settings.connections.map((c) => payload(draft(c))));
  const save = async () => {
    const result = await r.run(
      async () => {
        await api(PATH, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connections: rows.map(payload) }),
        });
        await r.reload();
        return true;
      },
      () => t("settingsEntries.common.saved"),
    );
    if (result) setRows((rows) => rows.map((c) => ({ ...c, token: "" })));
  };
  return (
    <SettingsGroup
      id="card-externalAgentConnections"
      title={t("externalAgents.remoteTitle")}
      description={t("externalAgents.remoteDescription")}
    >
      <LoadGate
        ready={r.settings !== null}
        error={r.loadError}
        onRetry={() => void r.reload()}
      >
        {r.settings ? (
          <>
            <p className="muted small">
              {t("externalAgents.botsHint", { ids: bots.join(", ") })}
            </p>
            {rows.length === 0 ? (
              <p className="muted">{t("externalAgents.remoteEmpty")}</p>
            ) : null}
            {rows.map((c, index) => {
              const id = `remote-agent-${index}`;
              return (
                <fieldset
                  key={c.rowKey}
                  data-external-agent-connection
                  disabled={r.busy}
                >
                  <legend>{c.name || t("externalAgents.newRemote")}</legend>
                  <TextField
                    id={`${id}-id`}
                    label={t("externalAgents.connectionId")}
                    value={c.id}
                    disabled={r.busy || c.tokenSet}
                    onChange={(id) => edit(c.rowKey, { id })}
                  />
                  <TextField
                    id={`${id}-name`}
                    label={t("externalAgents.name")}
                    value={c.name}
                    onChange={(name) => edit(c.rowKey, { name })}
                  />
                  <ToggleField
                    id={`${id}-enabled`}
                    label={t("externalAgents.remoteEnabled")}
                    checked={c.enabled}
                    onChange={(enabled) => edit(c.rowKey, { enabled })}
                  />
                  <TextField
                    id={`${id}-url`}
                    label={t("externalAgents.remoteUrl")}
                    hint={t("externalAgents.remoteUrlHint")}
                    value={c.baseUrl}
                    onChange={(baseUrl) => edit(c.rowKey, { baseUrl })}
                  />
                  <TextField
                    id={`${id}-token`}
                    type="password"
                    label={t("externalAgents.remoteToken")}
                    hint={t("externalAgents.tokenHint")}
                    value={c.token}
                    onChange={(token) => edit(c.rowKey, { token })}
                  />
                  <TextField
                    id={`${id}-bots`}
                    label={t("externalAgents.localBots")}
                    hint={t("externalAgents.localBotsHint")}
                    value={c.allowedBotIds}
                    onChange={(allowedBotIds) =>
                      edit(c.rowKey, { allowedBotIds })
                    }
                  />
                  <FieldRow
                    id={`${id}-kind`}
                    label={t("externalAgents.targetKind")}
                  >
                    <select
                      id={`${id}-kind`}
                      value={c.target.kind}
                      onChange={(e) =>
                        edit(c.rowKey, {
                          target: {
                            ...c.target,
                            kind: e.target.value === "bot" ? "bot" : "agent",
                          },
                        })
                      }
                    >
                      <option value="bot">
                        {t("externalAgents.targetBot")}
                      </option>
                      <option value="agent">
                        {t("externalAgents.targetAgent")}
                      </option>
                    </select>
                  </FieldRow>
                  <TextField
                    id={`${id}-target`}
                    label={t("externalAgents.targetId")}
                    value={c.target.id}
                    onChange={(id) =>
                      edit(c.rowKey, { target: { ...c.target, id } })
                    }
                  />
                  <ToggleField
                    id={`${id}-private`}
                    label={t("externalAgents.privateNetwork")}
                    hint={t("externalAgents.privateNetworkHint")}
                    checked={c.allowPrivateNetwork}
                    onChange={(allowPrivateNetwork) =>
                      edit(c.rowKey, { allowPrivateNetwork })
                    }
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setRows((rows) =>
                        rows.filter((row) => row.rowKey !== c.rowKey),
                      )
                    }
                  >
                    {t("externalAgents.removeRemote")}
                  </button>
                </fieldset>
              );
            })}
            <button
              className="btn btn-ghost btn-sm"
              disabled={r.busy}
              onClick={() =>
                setRows((rows) => [
                  ...rows,
                  {
                    rowKey: crypto.randomUUID(),
                    id: "",
                    name: "",
                    enabled: true,
                    baseUrl: "",
                    target: { kind: "bot", id: "" },
                    allowedBotIds: "",
                    allowPrivateNetwork: false,
                    tokenSet: false,
                    token: "",
                  },
                ])
              }
            >
              {t("externalAgents.addRemote")}
            </button>
            <SaveBar
              dirty={dirty}
              busy={r.busy}
              onSave={() => void save()}
              onReset={reset}
            />
          </>
        ) : null}
        <StatusLine status={r.status} />
      </LoadGate>
    </SettingsGroup>
  );
}
