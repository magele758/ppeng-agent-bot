"use client";
import { MemorySuppressions } from "../MemorySuppressions";
import { useEffect, useState } from "react";
import { ownedByBot, shownRows } from "@/lib/bot-panel-reset";
import { useI18n } from "@/lib/i18n";
import { api, json, useAction, Feedback, MessageContent } from "./shared";
import { useBotPanelRead } from "./use-bot-panel-read";
type Entry = {
  id: string;
  scope: string;
  key: string;
  value: string;
  source?: string;
  updatedAt?: string;
  revisions?: { value: string; source?: string; updatedAt: string }[];
  namespace?: string;
  userId?: string;
  tenantId?: string;
  agentId?: string;
  sessionId?: string;
  sourceRefs?: { sessionId: string; messageId: string; seq?: number }[];
};
export function BotMemory({
  botId,
  sessionId,
}: {
  botId: string;
  sessionId: string;
}) {
  const { t } = useI18n();
  const scopeLabel = (scope: string) => {
    switch(scope) {
      case 'session.scratch': return t('botWork.memoryScopeScratch');
      case 'session.long': return t('botWork.memoryScopeSession');
      case 'user.memory': return t('botWork.memoryScopeUser');
      case 'team.memory': return t('botWork.memoryScopeTeam');
      case 'project.memory': return t('botWork.memoryScopeProject');
      default: return scope;
    }
  };
  const action = useAction();
  const panel = useBotPanelRead(botId);
  const [loadedBotId, setLoadedBotId] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draftBotId, setDraftBotId] = useState("");
  const [editing, setEditing] = useState<Entry | null>(null);
  const [contextBotId, setContextBotId] = useState("");
  const [sourceError, setSourceError] = useState(false);
  const [fileDownload, setFileDownload] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [context, setContext] = useState<unknown>(null);
  const visibleEntries = shownRows(botId, loadedBotId, entries);
  const visibleDraft = ownedByBot(botId, draftBotId, editing);
  const visibleContext = ownedByBot(botId, contextBotId, context);
  const reload = async (requestedBotId: string, signal?: AbortSignal) => {
    const data = await panel.read(
      requestedBotId,
      () =>
        api(
          `/api/memory?agentId=${encodeURIComponent(requestedBotId)}&limit=200&includeRevisions=1`,
          { signal },
        ) as Promise<{ entries: Entry[] }>,
      signal,
    );
    if (!data) return;
    setLoadedBotId(requestedBotId);
    setEntries(data.entries);
  };
  useEffect(() => {
    setSourceError(false); setFileText(null); setFileDownload(null);
    const ac = new AbortController();
    void action.run(() => reload(botId, ac.signal));
    return () => ac.abort();
  }, [botId, sessionId]);
  return (
    <section className="ag-panel" data-testid="bot-memory">
      <h3>{t("memory.title")}</h3>
      <p>{t("botWork.memoryHistoryHint")}</p>
      <button disabled={action.busy} onClick={() => void action.run(() => reload(botId))}>
        {t("botWork.refresh")}
      </button>
      <Feedback {...action} />
      {botId === loadedBotId && !visibleEntries.length && !action.busy && <p>{t("botWork.empty")}</p>}
      {visibleEntries.map((entry) => (
        <article key={entry.id} className="memory-entry">
          <strong>{t(entry.key.startsWith('compact:') ? 'polish.memorySummary' : 'polish.memoryFact')}</strong>
          <p className="memory-entry__summary">{entry.value.slice(0, 240)}{entry.value.length > 240 ? '…' : ''}</p>
          <details><summary>{t('polish.details')}</summary><code>{entry.key}</code><p>{entry.value}</p>
          <p>{t("botWork.memoryScope", { scope: scopeLabel(entry.scope), namespace: entry.namespace ?? 'default' })}</p>
          <p>{t("botWork.memoryOrigin", { source: entry.source === 'user_correction' ? t("botWork.memoryUserCorrection") : entry.source ?? t("botWork.memoryOriginUnknown") })}</p>
          <p>{t("botWork.memoryUpdated", { time: entry.updatedAt ?? t("botWork.memoryOriginUnknown") })}</p>
          {!!entry.revisions?.length && <details>
            <summary>{t("botWork.memoryCorrections")}</summary>
            <p>{t("botWork.memoryCorrectionsHint")}</p>
            {entry.revisions.map((revision, index) => <article key={`${revision.updatedAt}:${index}`}>
              <time dateTime={revision.updatedAt}>{revision.updatedAt}</time><p>{revision.value}</p>
            </article>)}
          </details>}
          </details>
          <button
            disabled={action.busy}
            onClick={() => {
              setDraftBotId(botId);
              setEditing(entry);
            }}
          >
            {t("botWork.edit")}
          </button>
          <button
            disabled={action.busy}
            onClick={() => {
              const requestedBotId = botId;
              void action.run(async () => {
                await api(`/api/memory/${encodeURIComponent(entry.id)}`, {
                  method: "DELETE",
                });
                if (panel.selected() !== requestedBotId) return;
                await reload(requestedBotId);
              });
            }}
          >
            {t("botWork.remove")}
          </button>
          {entry.source && (entry.source.startsWith('artifact:') || /[/.\\]/.test(entry.source)) && <button disabled={action.busy} onClick={() => {
            const requestedBotId = botId;
            setSourceError(false); setContext(null); setFileText(null); setFileDownload(null); setContextBotId(botId);
            void action.run(async () => {
              try {
                const data = await api(`/api/sessions/${encodeURIComponent(entry.sessionId ?? sessionId)}/artifacts`) as { artifacts: { id: string; fileName?: string; localRelPath?: string; totalBytes?: number; mimeType?: string }[] };
                const source = entry.source!.replace(/^artifact:/, '');
                const file = data.artifacts.find(file => file.id === source || file.fileName === source || file.localRelPath === source);
                if (!file) throw new Error('missing');
                const response = await fetch(`/api/artifact/${encodeURIComponent(file.id)}/download`);
                if (!response.ok) throw new Error('unavailable');
                if ((file.totalBytes ?? 0) > 2_000_000 || !/text|json|xml|csv|javascript/.test(response.headers.get('content-type') ?? '')) {
                  await response.body?.cancel();
                  if (panel.selected() === requestedBotId) setFileDownload(`/api/artifact/${encodeURIComponent(file.id)}/download`);
                  return;
                }
                const blob = await response.blob();
                if (blob.size > 2_000_000 || !/text|json|xml|csv|javascript/.test(blob.type)) throw new Error('unsupported');
                const text = await blob.text();
                if (panel.selected() === requestedBotId) setFileText(text);
              } catch { if (panel.selected() === requestedBotId) setSourceError(true); }
            });
          }}>{t('polish.fileSource')}</button>}
          {!!entry.sourceRefs?.length && <details data-testid="memory-sources"><summary>{t('polish.sources', { count: entry.sourceRefs.length })}</summary>
          {entry.sourceRefs?.map((source) => (
            <button
              key={source.messageId}
              disabled={action.busy}
              onClick={() => {
                if (source.seq == null) { setContext(null); setFileText(null); setFileDownload(null); setSourceError(true); return; }
                const requestedBotId = botId;
                setSourceError(false); setContext(null); setFileText(null); setFileDownload(null);
                void action.run(async () => {
                  try {
                  const data = await panel.read(requestedBotId, () =>
                    api(
                      `/api/sessions/${encodeURIComponent(source.sessionId)}/history/${source.seq}`,
                    ),
                  );
                  if (!data) return;
                  setContextBotId(requestedBotId);
                  setContext(data);
                  } catch { if (panel.selected() === requestedBotId) setSourceError(true); }
                });
              }}
            >
              {t("botWork.source")} #{source.seq ?? source.messageId}
            </button>
          ))}</details>}
        </article>
      ))}
      {visibleDraft && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const requestedBotId = botId;
            const draft = visibleDraft;
            if (panel.selected() !== requestedBotId) return;
            void action.run(async () => {
              await api("/api/memory", json({ ...draft, source: 'user_correction' }));
              if (panel.selected() !== requestedBotId) return;
              setEditing(null);
              await reload(requestedBotId);
            });
          }}
        >
          <textarea
            required
            aria-label={t("memory.valueLabel")}
            value={visibleDraft.value}
            onChange={(e) => setEditing({ ...visibleDraft, value: e.target.value })}
          />
          <button disabled={action.busy}>{t("botWork.save")}</button>
          <button type="button" onClick={() => setEditing(null)}>
            {t("botWork.cancel")}
          </button>
        </form>
      )}
      <MemorySuppressions agentId={botId} revision={entries} onRestore={() => reload(botId)} />
      {contextBotId === botId && fileDownload && <section className="memory-source-preview" data-testid="memory-source-preview"><a href={fileDownload} download>{t('polish.downloadFile')}</a></section>}
      {sourceError && <p role="alert">{t('polish.sourceUnavailable')}</p>}
      {contextBotId === botId && fileText != null && <section className="memory-source-preview" data-testid="memory-source-preview"><h4>{t('polish.sourcePreview')}</h4><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{fileText}</pre></section>}
      {visibleContext != null && <section className="memory-source-preview" data-testid="memory-source-preview"><h4>{t('polish.sourcePreview')}</h4>
        {((visibleContext as { message?: { parts: unknown[] } }).message ? [(visibleContext as { message: { parts: unknown[] } }).message] : (visibleContext as { messages?: { parts: unknown[] }[] }).messages ?? []).map((message, index) => <MessageContent key={index} parts={message.parts ?? []} />)}
      </section>}
    </section>
  );
}
