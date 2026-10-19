"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useI18n, type MessageKey } from "@/lib/i18n";
type Plan = {
  environment: "local";
  host: string;
  entryUrl: string;
  visibility: "private" | "public";
  repository: string;
  repositoryNodeId: string;
  target: string;
  workerIds: string[];
  modelIds: string[];
  connectionIds: string[];
  sourceSha: string;
  daemonDigest: string;
  webDigest: string;
  maxTasks: number;
  maxRounds: number;
  maxCostUsd: number;
  deadlineMs: number;
  minFreeDiskGiB: number;
  scopeConfirmed: boolean;
  publicConfirmed: boolean;
  revision?: string;
};
type Run = { id: string; stage: string; settings: Plan; createdAt: string };
type Assessment = { ready: boolean; blockers: string[]; missing: string[] };
const initial: Plan = {
  environment: "local",
  host: "",
  entryUrl: "",
  visibility: "private",
  repository: "",
  repositoryNodeId: "",
  target: "main",
  workerIds: [],
  modelIds: [],
  connectionIds: [],
  sourceSha: "",
  daemonDigest: "",
  webDigest: "",
  maxTasks: 2,
  maxRounds: 8,
  maxCostUsd: 0,
  deadlineMs: 14400000,
  minFreeDiskGiB: 14,
  scopeConfirmed: false,
  publicConfirmed: false,
};
const endpoint = "/api/factory/production";
const body = (value: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
const textFields = [
  "host",
  "entryUrl",
  "repository",
  "repositoryNodeId",
  "target",
  "sourceSha",
  "daemonDigest",
  "webDigest",
] as const;
const listFields = ["workerIds", "modelIds", "connectionIds"] as const;
const numberFields = [
  "maxTasks",
  "maxRounds",
  "maxCostUsd",
  "deadlineMs",
  "minFreeDiskGiB",
] as const;
const reasonKeys: Record<string, string> = {
  "local-only": "productionLocalOnly",
  "deployment-scope-unconfirmed": "productionNeedScope",
  "real-project-unconfirmed": "productionNeedProject",
  "candidate-unconfirmed": "productionNeedCandidate",
  "workers-unconfirmed": "productionNeedWorkers",
  "supported-connections-unconfirmed": "productionNeedConnections",
  "model-budget-unconfirmed": "productionNeedBudget",
  "local-storage-unavailable": "productionNeedStorage",
  "local-disk-insufficient": "productionNeedDisk",
  "settings-changed": "productionSettingsChanged",
  "run-deadline-exceeded": "productionExpired",
};
const gateKeys: Record<string, string> = {
  build: "productionGateBuild",
  unit: "productionGateUnit",
  integration: "productionGateIntegration",
  browser: "productionGateBrowser",
  faults: "productionGateFaults",
  "migration-rollback": "productionGateMigration",
  performance: "productionGatePerformance",
  soak: "productionGateSoak",
  "live-model": "productionGateModel",
  "live-software": "productionGateSoftware",
  acceptance: "productionGateAcceptance",
  crap: "productionGateCrap",
  "runtime-identity": "productionGateRuntime",
  "real-project": "productionGateProject",
  "backup-restore": "productionGateBackup",
  "cutover-rollback": "productionGateCutover",
  review: "productionGateReview",
};
export function FactoryProduction() {
  const { t } = useI18n(),
    [plan, setPlan] = useState<Plan>(initial),
    [loaded, setLoaded] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [runs, setRuns] = useState<Run[]>([]),
    [selected, setSelected] = useState(""),
    [assessment, setAssessment] = useState<Assessment>(),
    [blockers, setBlockers] = useState<string[]>();
  const alive = useRef(true),
    locked = useRef(false),
    requestKey = useRef<{ revision: string; key: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function action(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    try {
      await fn();
    } catch {
      if (alive.current) setError(true);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function load() {
    await action(async () => {
      const [s, r] = (await Promise.all([
        api(endpoint + "/settings"),
        api(endpoint + "/runs"),
      ])) as [{ settings: Plan }, { runs: Run[] }];
      if (!alive.current) return;
      setPlan(s.settings);
      setRuns(r.runs);
      setLoaded(true);
      setDirty(false);
    });
  }
  function change<K extends keyof Plan>(key: K, value: Plan[K]) {
    setPlan((old) => ({ ...old, [key]: value }));
    setDirty(true);
    setBlockers(undefined);
    setAssessment(undefined);
  }
  const unsavedOrBusy = busy || dirty;
  const frozenDisabled = unsavedOrBusy || !plan.revision;
  const label = (field: string) =>
    t(
      ("factory.productionField" +
        field[0]!.toUpperCase() +
        field.slice(1)) as MessageKey,
    );
  const reason = (value: string) =>
    t(
      ("factory." +
        (reasonKeys[value] ?? "productionUnavailable")) as MessageKey,
    );
  const gate = (value: string) =>
    t(
      ("factory." + (gateKeys[value] ?? "productionUnavailable")) as MessageKey,
    );
  function renderPlanFields() {
    return (
      <fieldset disabled={busy}>
        <legend>{t("factory.productionPlan")}</legend>
        {textFields.map((field) => (
          <label key={field}>
            {label(field)}
            <input
              value={plan[field]}
              onChange={(e) => change(field, e.target.value)}
            />
          </label>
        ))}
        {listFields.map((field) => (
          <label key={field}>
            {label(field)}
            <input
              value={plan[field].join(", ")}
              onChange={(e) =>
                change(
                  field,
                  e.target.value
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                )
              }
            />
          </label>
        ))}
        {numberFields.map((field) => (
          <label key={field}>
            {label(field)}
            <input
              type="number"
              min="0"
              step={field === "maxCostUsd" ? "0.01" : "1"}
              value={plan[field]}
              onChange={(e) => change(field, Number(e.target.value))}
            />
          </label>
        ))}
        <label>
          {t("factory.productionVisibility")}
          <select
            value={plan.visibility}
            onChange={(e) =>
              change("visibility", e.target.value as Plan["visibility"])
            }
          >
            <option value="private">{t("factory.productionPrivate")}</option>
            <option value="public">{t("factory.productionPublic")}</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={plan.scopeConfirmed}
            onChange={(e) => change("scopeConfirmed", e.target.checked)}
          />
          {t("factory.productionScopeConfirmed")}
        </label>
        {plan.visibility === "public" && (
          <label>
            <input
              type="checkbox"
              checked={plan.publicConfirmed}
              onChange={(e) => change("publicConfirmed", e.target.checked)}
            />
            {t("factory.productionPublicConfirmed")}
          </label>
        )}
      </fieldset>
    );
  }
  function renderRunHistory() {
    return (
      <>
        {runs.length > 0 && (
          <>
            <label>
              {t("factory.productionRuns")}
              <select
                value={selected}
                disabled={busy}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setAssessment(undefined);
                }}
              >
                <option value="">{t("factory.deliverySelect")}</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.createdAt} ·{" "}
                    {run.settings.sourceSha.slice(0, 12) ||
                      t("factory.productionUnset")}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={busy || !selected}
              onClick={() =>
                void action(async () => {
                  const r = (await api(
                    endpoint +
                      "/runs/" +
                      encodeURIComponent(selected) +
                      "/assess",
                    body({}),
                  )) as { assessment: Assessment };
                  if (alive.current) setAssessment(r.assessment);
                })
              }
            >
              {t("factory.productionAssess")}
            </button>
            {selected && (
              <p>
                {t("factory.productionFrozen")}:{" "}
                {runs.find((r) => r.id === selected)?.settings.revision}
              </p>
            )}
          </>
        )}
      </>
    );
  }
  function renderLocalStatus() {
    return (
      <>
        {dirty && <p role="status">{t("factory.productionUnsaved")}</p>}
        {blockers && (
          <ul>
            {blockers.map((value) => (
              <li key={value}>{reason(value)}</li>
            ))}
          </ul>
        )}
        {assessment && (
          <div role="status">
            <p>{t("factory.productionNotReady")}</p>
            <ul>
              {assessment.blockers.map((value) => (
                <li key={value}>{reason(value)}</li>
              ))}
            </ul>
            <p>{t("factory.productionMissing")}</p>
            <ul>
              {assessment.missing.map((value) => (
                <li key={value}>{gate(value)}</li>
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }
  return (
    <details
      data-testid="factory-production"
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded && !locked.current) void load();
      }}
    >
      <summary>{t("factory.productionTitle")}</summary>
      <p>{t("factory.productionScope")}</p>
      {error && <p role="alert">{t("factory.productionError")}</p>}
      {!loaded ? (
        <p>{t("factory.loading")}</p>
      ) : (
        <>
          {renderPlanFields()}
          <div className="ag-actions">
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const r = (await api(
                    endpoint + "/settings",
                    body(plan, "PATCH"),
                  )) as { settings: Plan };
                  if (alive.current) {
                    setPlan(r.settings);
                    setDirty(false);
                    setAssessment(undefined);
                    setBlockers(undefined);
                  }
                })
              }
            >
              {t("factory.productionSave")}
            </button>
            <button disabled={unsavedOrBusy} onClick={() => void load()}>
              {t("factory.productionReload")}
            </button>
            <button
              disabled={frozenDisabled}
              onClick={() =>
                void action(async () => {
                  const r = (await api(endpoint + "/preflight", body({}))) as {
                    blockers: string[];
                  };
                  if (alive.current) setBlockers(r.blockers);
                })
              }
            >
              {t("factory.productionPreflight")}
            </button>
            <button
              disabled={frozenDisabled}
              onClick={() =>
                void action(async () => {
                  if (requestKey.current?.revision !== plan.revision)
                    requestKey.current = {
                      revision: plan.revision!,
                      key: crypto.randomUUID(),
                    };
                  const { run } = (await api(
                    endpoint + "/runs",
                    body({
                      requestKey: requestKey.current!.key,
                      expectedRevision: plan.revision,
                    }),
                  )) as { run: Run };
                  requestKey.current = null;
                  if (alive.current) {
                    setRuns((old) =>
                      [run, ...old.filter((r) => r.id !== run.id)].slice(0, 50),
                    );
                    setSelected(run.id);
                    setAssessment(undefined);
                  }
                })
              }
            >
              {t("factory.productionCreate")}
            </button>
          </div>
          {renderLocalStatus()}
          {renderRunHistory()}
        </>
      )}
    </details>
  );
}
