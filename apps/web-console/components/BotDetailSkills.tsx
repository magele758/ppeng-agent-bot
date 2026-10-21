"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { BotSkillSharing, useSkillBots } from "./BotSkillSharing";
type Action =
  "create" | "update" | "share" | "unshare" | "set_sharing" | "delete";
type Status = "pending" | "processing" | "saved" | "rejected" | "failed";
type Policy = { mode: "all" | "selected"; ids: string[] };
type Skill = {
  id: string;
  name: string;
  description: string;
  content?: string;
  source?: string;
  ownerBotId?: string;
  sharedBotIds?: string[];
  blockedBotIds?: string[];
  canManage: boolean;
  enabled: boolean;
  revision: string;
};
type Operation = {
  id: string;
  name: string;
  ownerBotId: string;
  input: { action: Action };
  authorization: "user" | "confirmation" | "pending";
  status: Status;
  updatedAt: string;
  error?: string;
};
type Data = {
  skills: Skill[];
  policy: Policy;
  revision: string;
  operations: Operation[];
};
export function BotDetailSkills({ botId }: { botId: string }) {
  return <SkillPanel key={botId} botId={botId} />;
}
function SkillPanel({ botId }: { botId: string }) {
  const { t } = useI18n();
  const bots = useSkillBots();
  const [data, setData] = useState<Data>();
  const [policy, setPolicy] = useState<Policy>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sharingDirty, setSharingDirty] = useState<Record<string, boolean>>({});
  const alive = useRef(true);
  const dirty =
    !!data && JSON.stringify(policy) !== JSON.stringify(data.policy);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty || Object.values(sharingDirty).some(Boolean);
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/skills`;
  const load = useCallback(
    async (reset = false) => {
      try {
        const result = (await api(endpoint)) as Data;
        if (alive.current) {
          setData(result);
          if (reset || !dirtyRef.current) setPolicy(result.policy);
          setError("");
        }
      } catch (e) {
        if (alive.current) setError(String(e instanceof Error ? e.message : e));
      }
    },
    [endpoint],
  );
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => {
      if (!dirtyRef.current) void load();
    }, 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = (await api(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy, revision: data?.revision }),
      })) as Data;
      if (alive.current) {
        setData(next);
        setPolicy(next.policy);
        setMessage(t("skillProposals.saved"));
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id;
  return (
    <section data-testid="bot-detail-skills">
      <h4>{t("skillProposals.detailTitle")}</h4>
      {policy && (
        <>
          <label>
            {t("skillProposals.selection")}{" "}
            <select
              aria-label={t("skillProposals.selection")}
              value={policy.mode}
              disabled={busy}
              onChange={(e) => {
                setPolicy({
                  ...policy,
                  mode: e.target.value as Policy["mode"],
                });
                setMessage("");
              }}
            >
              <option value="all">{t("skillProposals.selectAll")}</option>
              <option value="selected">{t("skillProposals.selectSome")}</option>
            </select>
          </label>{" "}
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            {t("skillProposals.saveSelection")}
          </button>
        </>
      )}
      {dirty && <p role="status">{t("skillProposals.unsaved")}</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button onClick={() => void load()}>
            {t("skillProposals.refresh")}
          </button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <label>
        {t("skillProposals.search")}{" "}
        <input
          aria-label={t("skillProposals.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>{" "}
      <button className="btn btn-ghost btn-sm" onClick={() => setQuery("")}>
        {t("skillProposals.clearSearch")}
      </button>
      {!data && !error && <p>{t("skillProposals.loading")}</p>}
      {data &&
        data.skills.filter((s) =>
          `${s.name} ${s.description}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ).length === 0 && <p>{t("skillProposals.noMatches")}</p>}
      {data?.skills
        .filter((s) =>
          `${s.name} ${s.description}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .map((skill) => (
          <div
            key={skill.id}
            data-testid={`skill-row-${skill.id}`}
            className="skill-capture-card"
          >
            <label>
              <input
                type="checkbox"
                aria-label={`${t("skillProposals.enableSkill")} ${skill.name} ${skill.id}`}
                disabled={policy?.mode !== "selected" || busy}
                checked={
                  policy?.mode === "all" || !!policy?.ids.includes(skill.id)
                }
                onChange={(e) => {
                  if (policy)
                    setPolicy({
                      ...policy,
                      ids: e.target.checked
                        ? [...policy.ids, skill.id]
                        : policy.ids.filter((id) => id !== skill.id),
                    });
                  setMessage("");
                }}
              />
              {skill.name}
            </label>
            <p>{skill.description}</p>
            <p>
              {skill.ownerBotId
                ? botName(skill.ownerBotId)
                : t(
                    skill.source === "user"
                      ? "skillProposals.legacyShared"
                      : "skillProposals.publicSkill",
                  )}{" "}
              ·{" "}
              {t(
                skill.source === "builtin"
                  ? "skillProposals.sourceBuiltin"
                  : skill.source === "workspace"
                    ? "skillProposals.sourceWorkspace"
                    : skill.source === "user"
                      ? "skillProposals.sourceUser"
                      : skill.source === "agents"
                        ? "skillProposals.sourceAgents"
                        : "skillProposals.sourceOther",
              )}{" "}
              ·{" "}
              {t(
                skill.canManage
                  ? "skillProposals.owned"
                  : skill.ownerBotId
                    ? "skillProposals.receivedReadOnly"
                    : "skillProposals.publicSkill",
              )}{" "}
              ·{" "}
              {t(
                skill.enabled
                  ? "skillProposals.effective"
                  : "skillProposals.restricted",
              )}
            </p>
            <small>{skill.id}</small>
            <details>
              <summary>{t("skillProposals.viewBody")}</summary>
              <pre style={{ whiteSpace: "pre-wrap" }}>{skill.content}</pre>
            </details>
            {skill.canManage && (
              <SkillActions
                key={`${skill.id}:${skill.revision}`}
                skill={skill}
                botId={botId}
                onDirty={(value) =>
                  setSharingDirty((current) =>
                    current[skill.id] === value
                      ? current
                      : { ...current, [skill.id]: value },
                  )
                }
                onChange={async () => {
                  await load();
                  setMessage(t("skillProposals.saved"));
                }}
              />
            )}
          </div>
        ))}
      <p className="muted">{t("skillProposals.unshareHistory")}</p>
      {!!data?.operations.length && (
        <details>
          <summary>{t("skillProposals.operationLog")}</summary>
          {data.operations.map((o) => (
            <p key={o.id}>
              {botName(o.ownerBotId)} · {o.name} ·{" "}
              {t(`skillProposals.action_${o.input.action}`)} ·{" "}
              {t(`skillProposals.auth_${o.authorization}`)} ·{" "}
              {t(`skillProposals.op_${o.status}`)} · {o.updatedAt}
              {o.error ? ` · ${o.error}` : ""}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
function SkillActions({
  skill,
  botId,
  onChange,
  onDirty,
}: {
  skill: Skill;
  botId: string;
  onChange: () => Promise<void>;
  onDirty: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const bots = useSkillBots();
  const [ids, setIds] = useState(skill.sharedBotIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  useEffect(() => {
    onDirtyRef.current(
      JSON.stringify(ids) !== JSON.stringify(skill.sharedBotIds ?? []),
    );
    return () => onDirtyRef.current(false);
  }, [ids, skill.sharedBotIds]);
  async function act(action: "set_sharing" | "delete") {
    const names = [botId, ...(skill.sharedBotIds ?? [])]
      .map((id) => bots.find((b) => b.id === id)?.name ?? id)
      .join(", ");
    if (
      action === "delete" &&
      !window.confirm(
        t("skillProposals.revokeAffected", { name: skill.name, bots: names }),
      )
    )
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/skills/manage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          skillId: skill.id,
          botIds: ids,
          revision: skill.revision,
        }),
      });
      await onChange();
      setMessage(t("skillProposals.saved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <BotSkillSharing
        bots={bots}
        owner={botId}
        selected={ids}
        onChange={setIds}
        disabled={busy}
      />
      {skill.blockedBotIds?.length ? (
        <p>
          {t("skillProposals.sharingRestricted", {
            names: skill.blockedBotIds
              .map((id) => bots.find((b) => b.id === id)?.name ?? id)
              .join(", "),
          })}
        </p>
      ) : null}
      <button
        className="btn btn-sm"
        disabled={busy}
        onClick={() => void act("set_sharing")}
      >
        {t("skillProposals.saveSharing")}
      </button>{" "}
      <button
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => void act("delete")}
      >
        {t("skillProposals.revoke")}
      </button>
      {JSON.stringify(ids) !== JSON.stringify(skill.sharedBotIds ?? []) && (
        <p>{t("skillProposals.unsaved")}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </>
  );
}
