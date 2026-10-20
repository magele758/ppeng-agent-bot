'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MemorySuppressions } from './MemorySuppressions';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { useLab } from './shell/LabProvider';
import { EmptyState, SettingsGroup } from './ui';
import {
  MEMORY_SCOPES,
  canAddMemory,
  filterMemoryEntries,
  scopeNeedsSession,
  type MemoryScopeId
} from './sections/knowledge/memory-model';
import styles from './sections/knowledge/knowledge.module.css';

export type MemoryEntryRow = {
  id: string;
  scope: string;
  key: string;
  value: string;
  namespace?: string;
  userId?: string;
  tenantId?: string;
  sessionId?: string;
  agentId?: string;
  sourceRefs?: Array<{sessionId:string;messageId:string;seq?:number}>;
};

type CuratorMode = 'inline' | 'observe_only' | 'off';
type EmbeddingMode = 'auto' | 'on' | 'off';

type MemorySettings = {
  curatorMode: CuratorMode;
  dialogueExtract: boolean;
  dreamerEnabled: boolean;
  compilerEnabled: boolean;
  embeddingRecallMode: EmbeddingMode;
  minTaskTools: number;
  updatedAt: string;
};

type ObservationRow = {
  id: string;
  kind: string;
  gate: string;
  gateReason?: string;
  taskContent?: string;
  createdAt: string;
};

type PreviewSection = {
  id: string;
  title: string;
  text: string;
  chars: number;
  capped: boolean;
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function MemoryPanel() {
  const { t } = useI18n();
  const { selectedSessionId, openSession } = useLab();
  const [scope, setScope] = useState<MemoryScopeId>('user.memory');
  const [rows, setRows] = useState<MemoryEntryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState({ key: '', value: '' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [source, setSource] = useState<string>('default');
  const [obs, setObs] = useState<ObservationRow[]>([]);
  const [previewQuery, setPreviewQuery] = useState('');
  const [userId, setUserId] = useState('local');
  const [sections, setSections] = useState<PreviewSection[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const report = (e: unknown) => setErr(e instanceof Error ? e.message : String(e));

  const loadEntries = useCallback(async () => {
    try {
      const q = new URLSearchParams({ scope, limit: '200' });
      const res = (await api(`/api/memory?${q}`)) as { entries?: MemoryEntryRow[]; items?: MemoryEntryRow[] };
      setRows(res.entries ?? res.items ?? []);
      setErr(null);
    } catch (e) {
      report(e);
    } finally {
      setLoaded(true);
    }
  }, [scope]);

  const loadSettings = useCallback(async () => {
    const data = (await api('/api/memory/settings')) as { settings: MemorySettings; source?: string };
    setSettings(data.settings);
    setSource(data.source ?? 'default');
  }, []);

  const loadObs = useCallback(async () => {
    const data = (await api('/api/memory/observations?limit=12')) as { observations?: ObservationRow[] };
    setObs(data.observations ?? []);
  }, []);

  useEffect(() => {
    setLoaded(false);
    setEditingId(null);
    setConfirmingId(null);
    void loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    void loadSettings().catch(report);
    void loadObs().catch(() => setObs([]));
  }, [loadSettings, loadObs]);

  const run = async (action: () => Promise<void>, okMessage?: string) => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await action();
      if (okMessage) setMsg(okMessage);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = (patch: Partial<MemorySettings>) =>
    run(async () => {
      const data = (await api('/api/memory/settings', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(patch)
      })) as { settings: MemorySettings; source?: string };
      setSettings(data.settings);
      setSource(data.source ?? 'ui');
    }, t('common.saved'));

  const sessionBlocked = scopeNeedsSession(scope) && !selectedSessionId;

  const addEntry = () =>
    run(async () => {
      await api('/api/memory', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          scope,
          namespace: 'default',
          key: draft.key.trim(),
          value: draft.value.trim(),
          ...(scopeNeedsSession(scope) ? { sessionId: selectedSessionId } : {})
        })
      });
      setDraft({ key: '', value: '' });
      await loadEntries();
    }, t('memory.added'));

  const saveEdit = (row: MemoryEntryRow) =>
    run(async () => {
      await api('/api/memory', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          scope: row.scope,
          namespace: row.namespace ?? 'default',
          key: row.key,
          value: editValue,
          userId: row.userId,
          tenantId: row.tenantId,
          sessionId: row.sessionId,
          agentId: row.agentId
        })
      });
      setEditingId(null);
      await loadEntries();
    }, t('memory.saved'));

  const removeEntry = (id: string) =>
    run(async () => {
      await api(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setConfirmingId(null);
      await loadEntries();
    }, t('memory.deleted'));

  const preview = () =>
    run(async () => {
      const data = (await api('/api/memory/preview', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ query: previewQuery, userId })
      })) as { pack?: { sections?: PreviewSection[] } };
      setSections(data.pack?.sections ?? []);
    });

  const visible = useMemo(() => filterMemoryEntries(rows, search), [rows, search]);
  const scopeMeta = MEMORY_SCOPES.find((s) => s.id === scope);

  return (
    <>
      <SettingsGroup title={t('memory.title')} description={t('memory.desc')}>
        <div id="memoryScopes" className={styles.scopes} role="group" aria-label={t('memory.scopesAria')}>
          {MEMORY_SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid={`memory-scope-${s.id}`}
              aria-pressed={scope === s.id}
              className={`${styles.scope}${scope === s.id ? ` ${styles.scopeActive}` : ''}`}
              onClick={() => setScope(s.id)}
            >
              <span className={styles.scopeLabel}>{t(`memory.scopes.${s.slug}.label` as MessageKey)}</span>
              <span className={styles.scopeDesc}>{t(`memory.scopes.${s.slug}.desc` as MessageKey)}</span>
            </button>
          ))}
        </div>

        <MemorySuppressions revision={rows} onRestore={loadEntries} />
        <div className={styles.toolbar}>
          <input
            id="memorySearch"
            className={`input ${styles.grow}`}
            type="search"
            aria-label={t('memory.searchLabel')}
            placeholder={t('memory.searchPh')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="badge">{t('memory.count', { n: visible.length })}</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadEntries()}>
            {t('memory.refresh')}
          </button>
        </div>

        {!loaded ? (
          <p className="muted">{t('common.loading')}</p>
        ) : rows.length === 0 ? (
          <EmptyState title={t('memory.emptyTitle')} description={t('memory.emptyDesc')} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={t('memory.noMatchTitle')}
            description={t('memory.noMatchDesc')}
            action={
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSearch('')}>
                {t('memory.clearSearch')}
              </button>
            }
          />
        ) : (
          <div id="listMemory" className={styles.list}>
            {visible.map((r) => (
              <div key={r.id} className={`list-item ${styles.row}`}>
                <div className={styles.rowMain}>
                  <strong className={styles.key}>{r.key}</strong>
                  {r.sessionId ? <span className="muted">{t('memory.sessionBound', { id: r.sessionId.slice(0, 8) })}</span> : null}
                </div>
                {editingId === r.id ? (
                  <>
                    <textarea
                      id="memoryEditValue"
                      rows={3}
                      aria-label={t('memory.editValueLabel')}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                    />
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy || !editValue.trim()}
                        onClick={() => void saveEdit(r)}
                      >
                        {t('memory.save')}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>
                        {t('memory.cancel')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className={styles.value}>{String(r.value)}</div>
                    {r.sourceRefs?.length ? <details><summary>{t('botWork.source')}</summary>{r.sourceRefs.map(source=><button key={source.messageId} type="button" onClick={()=>void openSession(source.sessionId,{focusChat:true})}>{source.messageId}{source.seq!=null?` #${source.seq}`:''}</button>)}</details> : null}
                    <div className={styles.actions}>
                      {confirmingId === r.id ? (
                        <>
                          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void removeEntry(r.id)}>
                            {t('memory.confirmDelete')}
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(null)}>
                            {t('memory.cancel')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                              setEditingId(r.id);
                              setEditValue(String(r.value));
                              setConfirmingId(null);
                            }}
                          >
                            {t('memory.edit')}
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(r.id)}>
                            {t('memory.delete')}
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t('memory.addTitle')}
        description={scopeMeta ? t(`memory.scopes.${scopeMeta.slug}.label` as MessageKey) : undefined}
        collapsible
      >
        <div className={styles.addGrid}>
          <label className={styles.field}>
            <span>{t('memory.keyLabel')}</span>
            <input id="memoryKey" className="input" placeholder={t('memory.keyPh')} value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
          </label>
          <label className={styles.field}>
            <span>{t('memory.valueLabel')}</span>
            <input id="memoryValue" className="input" placeholder={t('memory.valuePh')} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
          </label>
        </div>
        {sessionBlocked ? <p className="muted">{t('memory.needsSession')}</p> : null}
        <div className={styles.actions}>
          <button
            type="button"
            id="btnMemoryAdd"
            className="btn btn-primary"
            disabled={busy || sessionBlocked || !canAddMemory(draft)}
            onClick={() => void addEntry()}
          >
            {t('memory.add')}
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t('memory.behaviorTitle')}
        description={t('memory.behaviorDesc')}
      >
        {settings ? (
          <label className={styles.toggleRow}>
            <input
              id="memoryDialogueExtract"
              type="checkbox"
              disabled={busy}
              checked={settings.dialogueExtract}
              onChange={(e) => void saveSettings({ dialogueExtract: e.target.checked })}
            />
            <span>
              <span className={styles.toggleTitle}>{t('memory.learn')}</span>
              <span className={styles.toggleDesc}>{t('memory.learnDesc')}</span>
            </span>
          </label>
        ) : (
          <p className="muted">{t('common.loading')}</p>
        )}
        <span className="badge">{source === 'ui' ? t('memory.sourceUi') : t('memory.sourceDefault')}</span>
      </SettingsGroup>

      <SettingsGroup advanced title={t('memory.advancedTitle')} description={t('memory.advancedDesc')}>
        {settings ? (
          <>
            <label className={styles.field}>
              <span>{t('memory.curator')}</span>
              <select
                id="memoryCurator"
                className="input"
                disabled={busy}
                value={settings.curatorMode}
                onChange={(e) => void saveSettings({ curatorMode: e.target.value as CuratorMode })}
              >
                <option value="inline">{t('memory.curatorInline')}</option>
                <option value="observe_only">{t('memory.curatorObserveOnly')}</option>
                <option value="off">{t('memory.curatorOff')}</option>
              </select>
              <small className="muted">{t('memory.curatorHint')}</small>
            </label>
            <label className={styles.toggleRow}>
              <input
                id="memoryDreamer"
                type="checkbox"
                disabled={busy}
                checked={settings.dreamerEnabled}
                onChange={(e) => void saveSettings({ dreamerEnabled: e.target.checked })}
              />
              <span>
                <span className={styles.toggleTitle}>{t('memory.dreamer')}</span>
                <span className={styles.toggleDesc}>{t('memory.dreamerDesc')}</span>
              </span>
            </label>
            <label className={styles.toggleRow}>
              <input
                id="memoryCompiler"
                type="checkbox"
                disabled={busy}
                checked={settings.compilerEnabled}
                onChange={(e) => void saveSettings({ compilerEnabled: e.target.checked })}
              />
              <span>
                <span className={styles.toggleTitle}>{t('memory.compiler')}</span>
                <span className={styles.toggleDesc}>{t('memory.compilerDesc')}</span>
              </span>
            </label>
            <label className={styles.field}>
              <span>{t('memory.embeddingRecall')}</span>
              <select
                id="memoryEmbedding"
                className="input"
                disabled={busy}
                value={settings.embeddingRecallMode ?? 'auto'}
                onChange={(e) => void saveSettings({ embeddingRecallMode: e.target.value as EmbeddingMode })}
              >
                <option value="auto">{t('memory.embeddingModeAuto')}</option>
                <option value="on">{t('memory.embeddingModeOn')}</option>
                <option value="off">{t('memory.embeddingModeOff')}</option>
              </select>
              <small className="muted">{t('memory.embeddingHint')}</small>
            </label>
          </>
        ) : null}

        <h3 className={styles.subhead}>{t('memory.recentObs')}</h3>
        {obs.length === 0 ? (
          <p className="muted">{t('memory.emptyObs')}</p>
        ) : (
          <div className={styles.list}>
            {obs.map((o) => (
              <div key={o.id} className={`list-item ${styles.row}`}>
                <div className={styles.rowMain}>
                  <strong>{o.gate}</strong>
                  <span className="muted">{o.kind}</span>
                </div>
                <div className="muted">
                  {o.gateReason ?? ''} {o.taskContent ? `· ${o.taskContent.slice(0, 60)}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}

        <h3 className={styles.subhead}>{t('memory.previewTitle')}</h3>
        <div className={styles.addGrid}>
          <label className={styles.field}>
            <span>{t('memory.previewQueryLabel')}</span>
            <input id="memoryPreviewQuery" className="input" placeholder={t('memory.previewQueryPh')} value={previewQuery} onChange={(e) => setPreviewQuery(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('memory.userIdLabel')}</span>
            <input className="input" placeholder={t('memory.userIdPh')} value={userId} onChange={(e) => setUserId(e.target.value)} />
          </label>
        </div>
        <div className={styles.actions}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void preview()}>
            {t('memory.previewSlots')}
          </button>
        </div>
        {sections.length === 0 ? (
          <p className="muted">{t('memory.emptyPreview')}</p>
        ) : (
          sections.map((s) => (
            <div key={s.id} className={`list-item ${styles.row}`}>
              <div className={styles.rowMain}>
                <strong>{s.title}</strong>
                <span className="muted">{t('memory.sectionChars', { n: s.chars })}</span>
              </div>
              <pre className={styles.pre}>{s.text.slice(0, 400)}</pre>
            </div>
          ))
        )}
      </SettingsGroup>

      {msg ? (
        <p role="status" className="muted">
          {msg}
        </p>
      ) : null}
      {err ? (
        <p role="alert" className={styles.error}>
          {err}
        </p>
      ) : null}
    </>
  );
}
