'use client';

import { useEffect, useState } from 'react';
import { BotDetailSkills } from './BotDetailSkills';
import { RoutineSchedule, type ScheduleJob } from './RoutineSchedule';
import { api } from '@/lib/api';
import { botPermissionsHref } from '@/lib/bot-chat-header';
import {
  commitRoutineEnabled,
  commitRoutineRemoved,
  presentMemoryValue,
  redactSensitiveText,
  type RoutineToggle
} from '@/lib/bot-detail-menu';
import { useI18n, type MessageKey } from '@/lib/i18n';
import styles from './BotDetailMenu.module.css';

type Section = 'routines' | 'files' | 'memory' | 'skills';
type RoutineItem = RoutineToggle & ScheduleJob & { name: string; nextRunAt?: string; scheduleValue?: string };
type MaterialItem = { id: string; name: string; kind: 'artifact' | 'working-log'; createdAt?: string; sourceTool?: string };
type MemoryItem = { id: string; scope: string; key: string; value: string };

const SCOPE_KEY: Record<string, MessageKey> = {
  'session.scratch': 'play.botDetail.scopeScratch',
  'session.long': 'play.botDetail.scopeLong',
  'user.memory': 'play.botDetail.scopeUser',
  'team.memory': 'play.botDetail.scopeTeam',
  'project.memory': 'play.botDetail.scopeProject'
};

export type BotDetailPreview = {
  jobs: RoutineItem[];
  files: MaterialItem[];
  memories: MemoryItem[];
};


function DetailSectionState({ loading, failed, count, emptyKey }: { loading: boolean; failed: boolean; count: number; emptyKey: MessageKey }) {
  const { t } = useI18n();
  if (failed) return <p className={styles.alert} role="alert">{t('play.botDetail.loadFailed')}</p>;
  if (loading || count > 0) return null;
  return <p className={styles.empty}>{t(emptyKey)}</p>;
}
function DetailNextRun({ when }: { when?: string }) {
  const { t } = useI18n();
  return when ? <p className={styles.meta}>{t('play.botDetail.next', { when })}</p> : null;
}
function fulfilledList<T>(result: PromiseSettledResult<unknown>, field: string): T[] {
  if (result.status !== 'fulfilled') return [];
  const value = (result.value as Record<string, unknown>)[field];
  return Array.isArray(value) ? value as T[] : [];
}

function DetailRoutines({ onSaved, jobs, loading, failed, toggleError, deleteError, busyId, onToggle, onDelete }: { onSaved: (job: ScheduleJob) => void; jobs: RoutineItem[]; loading: boolean; failed: boolean; toggleError: boolean; deleteError: boolean; busyId: string | null; onToggle: (job: RoutineItem) => void; onDelete: (job: RoutineItem) => void }) {
  const { t } = useI18n();
  const hidden = t('play.botDetail.redacted');
  return (<section data-testid="bot-detail-section-routines" aria-label={t('play.botDetail.routines')}>
            <DetailSectionState loading={loading} failed={failed} count={jobs.length} emptyKey="play.botDetail.routinesEmpty" />
            {toggleError ? <p className={styles.alert} role="alert">{t('play.botDetail.toggleFailed')}</p> : null}
            {deleteError ? <p className={styles.alert} role="alert">{t('play.botDetail.removeFailed')}</p> : null}
            {jobs.map((job) => (
              <article key={job.id} className={styles.item} data-testid="bot-detail-routine" data-routine-id={job.id} data-enabled={job.enabled ? 'true' : 'false'}>
                <div className={styles.name}>{redactSensitiveText(job.name || job.id, hidden)}</div>
                <p className={styles.meta}>{job.enabled ? t('play.botDetail.on') : t('play.botDetail.off')}</p>
                <RoutineSchedule job={job} onSaved={onSaved} />
                <DetailNextRun when={job.enabled ? job.nextRunAt : undefined} />
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-testid="bot-detail-routine-toggle"
                    aria-pressed={job.enabled}
                    disabled={busyId === job.id}
                    onClick={() => onToggle(job)}
                  >
                    {job.enabled ? t('play.botDetail.turnOff') : t('play.botDetail.turnOn')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-testid="bot-detail-routine-delete"
                    disabled={busyId === job.id}
                    onClick={() => onDelete(job)}
                  >
                    {t('play.botDetail.remove')}
                  </button>
                </div>
              </article>
            ))}
          </section>);
}

function DetailFiles({ files, loading, failed, folderError, folderOk, busyId, onOpenFolder }: { files: MaterialItem[]; loading: boolean; failed: boolean; folderError: boolean; folderOk: boolean; busyId: string | null; onOpenFolder: (id: string) => void }) {
  const { t } = useI18n();
  const hidden = t('play.botDetail.redacted');
  return (<section data-testid="bot-detail-section-files" aria-label={t('play.botDetail.files')}>
            <DetailSectionState loading={loading} failed={failed} count={files.length} emptyKey="play.botDetail.filesEmpty" />
            {folderError ? <p className={styles.alert} role="alert">{t('play.botDetail.openFolderFailed')}</p> : null}
            {folderOk ? <p className={styles.ok}>{t('play.botDetail.openedFolder')}</p> : null}
            {files.map((file) => (
              <article key={file.id} className={styles.item} data-testid="bot-detail-file" data-material-id={file.id}>
                <div className={styles.name}>{redactSensitiveText(file.name || file.id, hidden)}</div>
                <p className={styles.meta}>
                  {file.kind === 'working-log' ? t('play.botDetail.kindWorkingLog') : t('play.botDetail.kindArtifact')}
                </p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-testid="bot-detail-open-folder"
                    disabled={busyId === file.id}
                    onClick={() => onOpenFolder(file.id)}
                  >
                    {t('play.botDetail.openFolder')}
                  </button>
                </div>
              </article>
            ))}
          </section>);
}

function DetailMemories({ memories, loading, failed }: { memories: MemoryItem[]; loading: boolean; failed: boolean }) {
  const { t } = useI18n();
  const hidden = t('play.botDetail.redacted');
  return (<section data-testid="bot-detail-section-memory" aria-label={t('play.botDetail.memory')}>
            <DetailSectionState loading={loading} failed={failed} count={memories.length} emptyKey="play.botDetail.memoryEmpty" />
            {memories.map((entry) => (
              <article key={entry.id} className={styles.item} data-testid="bot-detail-memory">
                <div className={styles.name}>{redactSensitiveText(entry.key, hidden)}</div>
                <p className={styles.meta}>{t(SCOPE_KEY[entry.scope] ?? 'play.botDetail.scopeOther')}</p>
                <p className={styles.value}>{presentMemoryValue(entry.key, entry.value, hidden)}</p>
              </article>
            ))}
          </section>);
}


function DetailBody({ onSaved, section, loading, sectionError, jobs, files, memories, toggleError, deleteError, folderError, folderOk, busyId, onToggle, onDelete, onOpenFolder }: {
  onSaved: (job: ScheduleJob) => void; section: Section; loading: boolean; sectionError: Record<Exclude<Section, 'skills'>, boolean>; jobs: RoutineItem[]; files: MaterialItem[]; memories: MemoryItem[];
  toggleError: boolean; deleteError: boolean; folderError: boolean; folderOk: boolean; busyId: string | null; onToggle: (job: RoutineItem) => void; onDelete: (job: RoutineItem) => void; onOpenFolder: (id: string) => void;
}) {
  const { t } = useI18n();
  return (      <div className={styles.body}>
        {loading ? <p className={styles.meta}>{t('play.botDetail.loading')}</p> : null}
        {section === 'routines' ? <DetailRoutines onSaved={onSaved} jobs={jobs} loading={loading} failed={sectionError.routines} toggleError={toggleError} deleteError={deleteError} busyId={busyId} onToggle={onToggle} onDelete={onDelete} /> : null}
        {section === 'files' ? <DetailFiles files={files} loading={loading} failed={sectionError.files} folderError={folderError} folderOk={folderOk} busyId={busyId} onOpenFolder={onOpenFolder} /> : null}
        {section === 'memory' ? <DetailMemories memories={memories} loading={loading} failed={sectionError.memory} /> : null}
      </div>);
}

export function BotDetailMenu({
  botId,
  botName,
  agentId,
  open = true,
  onClose,
  initialSection = 'routines',
  preview,
  showToggleError = false
}: {
  botId: string;
  botName: string;
  agentId?: string;
  open?: boolean;
  onClose?: () => void;
  initialSection?: Section;
  preview?: BotDetailPreview;
  showToggleError?: boolean;
}) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>(initialSection);
  const initial = preview ?? { jobs: [], files: [], memories: [] };
  const [jobs, setJobs] = useState<RoutineItem[]>(initial.jobs);
  const [files, setFiles] = useState<MaterialItem[]>(initial.files);
  const [memories, setMemories] = useState<MemoryItem[]>(initial.memories);
  const [loading, setLoading] = useState(!preview);
  const [sectionError, setSectionError] = useState({ routines: false, files: false, memory: false });
  const [toggleError, setToggleError] = useState(showToggleError);
  const [deleteError, setDeleteError] = useState(false);
  const [folderError, setFolderError] = useState(false);
  const [folderOk, setFolderOk] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const memoryAgentId = agentId || botId;

  useEffect(() => {
    if (preview) return;
    const ac = new AbortController();
    setLoading(true);
    setSectionError({ routines: false, files: false, memory: false });
    setJobs([]);
    setFiles([]);
    setMemories([]);
    setToggleError(false);
    setDeleteError(false);
    setFolderError(false);
    setFolderOk(false);
    void (async () => {
      const [jobResult, fileResult, memoryResult] = await Promise.allSettled([
        api(`/api/cron/jobs?botId=${encodeURIComponent(botId)}`, { signal: ac.signal }),
        api(`/api/bots/${encodeURIComponent(botId)}/materials`, { signal: ac.signal }),
        api(`/api/memory?agentId=${encodeURIComponent(memoryAgentId)}&limit=100`, { signal: ac.signal })
      ]);
      if (ac.signal.aborted) return;
      setJobs(fulfilledList<RoutineItem>(jobResult, 'jobs'));
      setFiles(fulfilledList<MaterialItem>(fileResult, 'materials'));
      setMemories(fulfilledList<MemoryItem>(memoryResult, 'entries'));
      setSectionError({
        routines: jobResult.status === 'rejected',
        files: fileResult.status === 'rejected',
        memory: memoryResult.status === 'rejected'
      });
      setLoading(false);
    })();
    return () => ac.abort();
  }, [botId, memoryAgentId, preview]);

  if (!open) return null;

  const onToggle = (job: RoutineItem) => {
    const next = !job.enabled;
    setBusyId(job.id);
    setToggleError(false);
    void commitRoutineEnabled(jobs, job.id, next, async (id, enabled) => {
      const data = (await api(`/api/cron/jobs/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      })) as { job?: { enabled?: boolean } };
      if (typeof data.job?.enabled !== 'boolean') throw new Error('toggle_failed');
      return { enabled: data.job.enabled };
    }).then((result) => {
      if (result.applied) {
        const saved = result.jobs.find((item) => item.id === job.id);
        if (saved && saved.enabled === next) {
          setJobs((current) => current.map((item) => (item.id === job.id ? { ...item, enabled: saved.enabled } : item)));
        }
      }
      setToggleError(!result.applied);
      setBusyId((current) => (current === job.id ? null : current));
    });
  };
  const onDelete = (job: RoutineItem) => {
    setBusyId(job.id);
    setDeleteError(false);
    void commitRoutineRemoved(jobs, job.id, async (id) => {
      await api(`/api/cron/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }).then((result) => {
      if (result.applied) setJobs((current) => current.filter((item) => item.id !== job.id));
      setDeleteError(!result.applied);
      setBusyId((current) => (current === job.id ? null : current));
    });
  };
  const onOpenFolder = (id: string) => {
    setBusyId(id);
    setFolderError(false);
    setFolderOk(false);
    void api(`/api/bots/${encodeURIComponent(botId)}/materials/${encodeURIComponent(id)}/reveal`, { method: 'POST' })
      .then(() => setFolderOk(true))
      .catch(() => setFolderError(true))
      .finally(() => setBusyId(null));
  };

  return (
    <aside
      id="bot-detail-panel"
      className={`bot-detail-menu ${styles.panel}`}
      data-testid="bot-detail-panel"
      data-bot-id={botId}
      aria-label={t('play.botDetail.aria')}
    >
      <div className={styles.head}>
        <h3 className={styles.title}>{t('play.botDetail.title', { name: botName })}</h3>
        {onClose && <button type="button" className={styles.close} data-testid="bot-detail-close" aria-label={t('play.botDetail.close')} title={t('play.botDetail.close')} onClick={onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>}
      </div>
      <div className={styles.tabs} role="tablist" aria-label={t('play.botDetail.aria')}>
        {(['routines', 'files', 'memory', 'skills'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={`${styles.tab}${section === id ? ` ${styles.tabActive}` : ''}`}
            data-testid={`bot-detail-tab-${id}`}
            aria-selected={section === id}
            onClick={() => setSection(id)}
          >
            {t(id === 'skills' ? 'skillProposals.detailTab' : id === 'routines' ? 'play.botDetail.routines' : id === 'files' ? 'play.botDetail.files' : 'play.botDetail.memory')}
          </button>
        ))}
      </div>
      <div className={styles.body} hidden={section !== 'skills'}>{section === 'skills' && <BotDetailSkills botId={botId} />}</div>
      {section !== 'skills' && <DetailBody onSaved={updated => setJobs(current => current.map(job => job.id === updated.id ? { ...job, ...updated } : job))} section={section} loading={loading} sectionError={sectionError} jobs={jobs} files={files} memories={memories} toggleError={toggleError} deleteError={deleteError} folderError={folderError} folderOk={folderOk} busyId={busyId} onToggle={onToggle} onDelete={onDelete} onOpenFolder={onOpenFolder} />}
    </aside>
  );
}

export function botDetailIsVisible(open: boolean, botId: string, groupId: string | null): boolean {
  return open && Boolean(botId) && groupId == null;
}
export function botDetailMainClass(visible: boolean): string {
  return `play-main-col${visible ? ' is-bot-detail-open' : ''}`;
}
export function BotDetailToggle({ botId, open, onToggle }: { botId: string; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  if (!botId) return null;
  return <button type="button" className="chat-panel-header__detail" data-testid="bot-detail-toggle" aria-expanded={open} aria-controls="bot-detail-panel" onClick={onToggle}>
    {open ? t('play.botDetail.close') : t('play.botDetail.open')}
  </button>;
}
export function BotDetailPane({ visible, botId, botName, agentId, onClose }: { visible: boolean; botId: string; botName: string; agentId?: string; onClose: () => void }) {
  if (!visible) return null;
  return <BotDetailMenu key={botId} botId={botId} botName={botName || botId} agentId={agentId || botId} onClose={onClose} />;
}

export function BotPermissionsLink({ botId, botName }: { botId: string; botName: string }) {
  const { t } = useI18n();
  if (!botId) return null;
  return <a className="chat-panel-header__permissions" href={botPermissionsHref(botId)} data-testid="chat-header-permissions" aria-label={t('play.header.permissionsAria', { name: botName })}>
    {t('play.header.permissions')}
  </a>;
}
