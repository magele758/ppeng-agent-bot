"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useI18n, type MessageKey } from "@/lib/i18n";
type Machine = { id: string; name: string; repositories: { id: string }[] };
const send = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const initial = {
  enabled: false,
  allowedUserIds: [] as string[],
  repository: "",
  repositoryNodeId: "",
  target: "main",
  credentialRef: "",
  operations: ["push", "pr"],
  requiredChecks: [{ workflowId: 0, job: "", appId: 15368 }],
  workflowDigests: {},
  ciVariablesDigest: "",
  mergeIdentity: undefined as
    | {
        appId: number;
        installationId: number;
        credentialRef: string;
        rulesetId: number;
      }
    | undefined,
  mergeMethod: "squash",
  maxRetries: 1,
  deadlineMs: 3600000,
  downstream: { confirmed: false, deploys: false },
};
export function FactoryDelivery({ machines }: { machines: Machine[] }) {
  const { t } = useI18n(),
    [machine, setMachine] = useState(""),
    [repo, setRepo] = useState(""),
    [p, setP] = useState(initial),
    [checks, setChecks] = useState("[]"),
    [digests, setDigests] = useState("{}"),
    [mergeIdentity, setMergeIdentity] = useState("null"),
    [result, setResult] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [loaded, setLoaded] = useState(false),
    [dirty, setDirty] = useState(false);
  const epoch = useRef(0);
  const url = `/api/factory/delivery/${encodeURIComponent(machine)}/${encodeURIComponent(repo)}`;
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await fn();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const version = ++epoch.current;
    setP(initial);
    setLoaded(false);
    setDirty(false);
    setResult(undefined);
    setError(false);
    if (!machine || !repo) return;
    void api(url)
      .then((v) => {
        if (version !== epoch.current) return;
        const saved = (v as { settings: Partial<typeof initial> }).settings;
        const next = { ...initial, ...saved };
        setP(next);
        setLoaded(true);
        setChecks(JSON.stringify(next.requiredChecks, null, 2));
        setDigests(JSON.stringify(next.workflowDigests, null, 2));
        setMergeIdentity(JSON.stringify(next.mergeIdentity ?? null, null, 2));
      })
      .catch(() => {
        if (version === epoch.current) setError(true);
      });
    return () => {
      epoch.current++;
    };
  }, [url, machine, repo]);
  const field = (
    key:
      | "repository"
      | "repositoryNodeId"
      | "target"
      | "credentialRef"
      | "ciVariablesDigest",
  ) => (
    <label>
      {t(
        ("factory.delivery" +
          key[0]!.toUpperCase() +
          key.slice(1)) as MessageKey,
      )}
      <input
        value={p[key]}
        disabled={busy}
        onChange={(e) => setP({ ...p, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <details data-testid="factory-delivery-settings">
      <summary>{t("factory.deliveryTitle")}</summary>
      <p>{t("factory.deliveryScope")}</p>
      <label>
        {t("factory.machine")}
        <select
          value={machine}
          disabled={busy}
          onChange={(e) => {
            setMachine(e.target.value);
            setRepo("");
          }}
        >
          <option value="">{t("factory.deliverySelect")}</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("factory.repositories")}
        <select
          value={repo}
          disabled={busy}
          onChange={(e) => setRepo(e.target.value)}
        >
          <option value="">{t("factory.deliverySelect")}</option>
          {machines
            .find((m) => m.id === machine)
            ?.repositories.map((r) => (
              <option key={r.id}>{r.id}</option>
            ))}
        </select>
      </label>
      {machine && repo && (
        <fieldset disabled={busy || !loaded} onChange={() => setDirty(true)}>
          <label>
            <input
              type="checkbox"
              checked={p.enabled}
              onChange={(e) => setP({ ...p, enabled: e.target.checked })}
            />
            {t("factory.deliveryEnable")}
          </label>
          {field("repository")}
          {field("repositoryNodeId")}
          {field("target")}
          {field("credentialRef")}
          {field("ciVariablesDigest")}
          <label>
            {t("factory.deliveryMergeIdentity")}
            <textarea
              value={mergeIdentity}
              onChange={(e) => setMergeIdentity(e.target.value)}
            />
          </label>
          <label>
            {t("factory.deliveryUsers")}
            <input
              value={p.allowedUserIds.join(",")}
              onChange={(e) =>
                setP({
                  ...p,
                  allowedUserIds: e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={p.operations.includes("merge")}
              onChange={(e) =>
                setP({
                  ...p,
                  operations: e.target.checked
                    ? ["push", "pr", "merge"]
                    : ["push", "pr"],
                })
              }
            />
            {t("factory.deliveryAllowMerge")}
          </label>
          <label>
            {t("factory.deliveryChecks")}
            <textarea
              value={checks}
              onChange={(e) => setChecks(e.target.value)}
            />
          </label>
          <label>
            {t("factory.deliveryWorkflows")}
            <textarea
              value={digests}
              onChange={(e) => setDigests(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={p.downstream.confirmed}
              onChange={(e) =>
                setP({
                  ...p,
                  downstream: { confirmed: e.target.checked, deploys: false },
                })
              }
            />
            {t("factory.deliveryDownstream")}
          </label>
          <label>
            {t("factory.deliveryRetries")}
            <input
              type="number"
              min="0"
              max="5"
              value={p.maxRetries}
              onChange={(e) =>
                setP({ ...p, maxRetries: Number(e.target.value) })
              }
            />
          </label>
          <label>
            {t("factory.deliveryDeadline")}
            <input
              type="number"
              min="1000"
              max="86400000"
              value={p.deadlineMs}
              onChange={(e) =>
                setP({ ...p, deadlineMs: Number(e.target.value) })
              }
            />
          </label>
          <button
            onClick={() =>
              void run(async () => {
                const v = await api(
                  url,
                  send(
                    {
                      ...p,
                      requiredChecks: JSON.parse(checks),
                      workflowDigests: JSON.parse(digests),
                      mergeIdentity: JSON.parse(mergeIdentity) ?? undefined,
                    },
                    "PATCH",
                  ),
                );
                setResult(v);
                setDirty(false);
              })
            }
          >
            {t("factory.save")}
          </button>
          <button
            disabled={dirty}
            onClick={() =>
              void run(async () =>
                setResult(await api(url + "/preflight", send({}))),
              )
            }
          >
            {t("factory.deliveryPreflight")}
          </button>
        </fieldset>
      )}
      <DeliveryFeedback error={error} value={result} />
    </details>
  );
}
type Delivery = {
  evidenceSnapshot?: { digest: string; bytes: number; available: boolean };
  stage: string;
  candidate: string;
  deployment: string;
  reason?: string;
  pr?: { url: string; number: number };
  mergeSha?: string;
};
function DeliveryFeedback({
  error,
  value,
}: {
  error: boolean;
  value: unknown;
}) {
  const { t } = useI18n();
  return (
    <>
      {error && <p role="alert">{t("factory.error")}</p>}
      {value !== undefined && <pre>{JSON.stringify(value, null, 2)}</pre>}
    </>
  );
}
function DeliverySummary({ delivery }: { delivery: Delivery | null }) {
  const { t } = useI18n();
  return (
    <>
      <p>
        {t("factory.deliveryState")}:{" "}
        {delivery?.stage ?? t("factory.deliveryNoGrant")}
      </p>
      <p>{t("factory.deliveryDeployment")}</p>
      {delivery && <DeliveryFacts delivery={delivery} />}
    </>
  );
}
function DeliveryFacts({ delivery }: { delivery: Delivery }) {
  const { t } = useI18n();
  return (
    <>
      <code>{delivery.candidate}</code>
      {delivery.pr && (
        <a href={delivery.pr.url} target="_blank" rel="noreferrer">
          PR #{delivery.pr.number}
        </a>
      )}
      {delivery.mergeSha && (
        <p>
          {t("factory.deliveryMergeSha")}: <code>{delivery.mergeSha}</code>
        </p>
      )}
      {delivery.reason && <p>{delivery.reason}</p>}
    </>
  );
}
type TaskActions = {
  delivery: Delivery | null;
  busy: boolean;
  act: (endpoint: string, body: unknown) => Promise<void>;
  read: () => void;
};
function DeliveryActions({ delivery, busy, act, read }: TaskActions) {
  const { t } = useI18n();
  return (
    <fieldset disabled={busy}>
      <button onClick={() => void act("/grant", { scope: "PR" })}>
        {t("factory.deliveryGrantPR")}
      </button>
      <button onClick={() => void act("/grant", { scope: "MERGED" })}>
        {t("factory.deliveryGrantMerge")}
      </button>
      {delivery && (
        <>
          <button onClick={() => void act("/verify", {})}>
            {t("factory.deliveryVerify")}
          </button>
          <DeliveryControls delivery={delivery} act={act} />
        </>
      )}
      <button onClick={read}>{t("factory.devEvidence")}</button>
    </fieldset>
  );
}
function DeliveryControls({
  delivery,
  act,
}: Pick<TaskActions, "act"> & { delivery: Delivery }) {
  const { t } = useI18n();
  return (
    <>
      <button onClick={() => void act("/control", { action: "revoke" })}>
        {t("factory.deliveryRevoke")}
      </button>
      <button onClick={() => void act("/control", { action: "pause" })}>
        {t("factory.deliveryPause")}
      </button>
      <button onClick={() => void act("/control", { action: "cancel" })}>
        {t("factory.deliveryCancel")}
      </button>
      <DeliveryRounds act={act} />
      <button onClick={() => void act("/decision", { action: "resume" })}>
        {t("factory.deliveryResume")}
      </button>
      <button
        onClick={() =>
          void act("/decision", {
            action: "confirm-sensitive",
            sha: delivery.candidate,
          })
        }
      >
        {t("factory.deliverySensitive")}
      </button>
    </>
  );
}
function DeliveryRounds({ act }: Pick<TaskActions, "act">) {
  const { t } = useI18n(),
    [rounds, setRounds] = useState(1);
  return (
    <>
      <label>
        {t("factory.devAdditionalRounds")}
        <input
          type="number"
          min="1"
          max="20"
          value={rounds}
          onChange={(e) => setRounds(Number(e.target.value))}
        />
      </label>
      <button
        onClick={() => void act("/decision", { action: "add-rounds", rounds })}
      >
        {t("factory.devAddRounds")}
      </button>
    </>
  );
}
function DeliverySnapshot({
  delivery,
  read,
}: {
  delivery: Delivery | null;
  read: (path: string) => void;
}) {
  const { t } = useI18n();
  if (!delivery?.evidenceSnapshot?.available) return null;
  return (
    <button
      onClick={() => read("/evidence/" + delivery.evidenceSnapshot!.digest)}
    >
      {t("factory.deliverySnapshot")}
    </button>
  );
}
export function FactoryDeliveryTask({ id }: { id: string }) {
  const { t } = useI18n(),
    [delivery, setDelivery] = useState<Delivery | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [evidence, setEvidence] = useState<unknown>();
  const snapshotOffset = useRef(0),
    mounted = useRef(true),
    pending = useRef(false),
    requestVersion = useRef(0);
  const url = `/api/factory/delivery/tasks/${encodeURIComponent(id)}`;
  const safe = (fn: () => void) => {
    if (mounted.current) fn();
  };
  useEffect(() => {
    mounted.current = true;
    snapshotOffset.current = 0;
    let active = true;
    const refresh = () => {
      if (pending.current) return;
      const version = ++requestVersion.current;
      void api(url)
        .then((v) => {
          if (active && version === requestVersion.current)
            setDelivery((v as { delivery: Delivery | null }).delivery);
        })
        .catch(() => {
          if (active && version === requestVersion.current) setError(true);
        });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      mounted.current = false;
      clearInterval(timer);
    };
  }, [url]);
  async function act(endpoint: string, body: unknown) {
    if (pending.current) return;
    pending.current = true;
    const version = ++requestVersion.current;
    setBusy(true);
    setError(false);
    try {
      const value = await api(url + endpoint, send(body));
      safe(() => {
        if (version !== requestVersion.current) return;
        setDelivery((value as { delivery: Delivery }).delivery);
        setEvidence(value);
      });
    } catch {
      safe(() => setError(true));
    } finally {
      pending.current = false;
      safe(() => setBusy(false));
    }
  }
  function read(path = "") {
    void api(url + path)
      .then((value) => safe(() => setEvidence(value)))
      .catch(() => safe(() => setError(true)));
  }
  function snapshot(path: string) {
    void api(url + path + "?offset=" + snapshotOffset.current)
      .then((value) =>
        safe(() => {
          setEvidence(value);
          const page = value as { nextOffset: number; totalBytes: number };
          snapshotOffset.current =
            page.nextOffset < page.totalBytes ? page.nextOffset : 0;
        }),
      )
      .catch(() => safe(() => setError(true)));
  }
  return (
    <section data-testid="factory-delivery-task">
      <h5>{t("factory.deliveryTitle")}</h5>
      <p>{t("factory.deliveryScope")}</p>
      <DeliverySummary delivery={delivery} />
      <DeliveryActions
        delivery={delivery}
        busy={busy}
        act={act}
        read={() => read()}
      />
      <DeliverySnapshot delivery={delivery} read={snapshot} />
      <DeliveryFeedback error={error} value={evidence} />
    </section>
  );
}
