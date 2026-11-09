'use client';

import { useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { listGrokSessions, readGrokHistory, type GrokMessage, type GrokSession } from '@/lib/grok-history';
import { directoryPicker, rememberedDirectory, replicaFiles, type GrokDirectory } from '@/lib/grok-directory';
import { archivedMarkdownHtml } from '@/lib/markdown';
import { ChatMarkdownHost } from './ChatMarkdownHost';
import './grok-history.css';

function MessageBody({row}: {row: GrokMessage}) {
  const { t } = useI18n();
  if (row.attachment) return <p>{t('play.grok.attachment', {name: row.text})}</p>;
  if (row.role === 'user') return <p className="grok-user-text">{row.text}</p>;
  return <ChatMarkdownHost html={archivedMarkdownHtml(row.text)} className="chat-md"
    copyLabel={t('play.markdown.copyCode')} copiedLabel={t('play.markdown.copied')} />;
}

function Transcript({messages}: {messages: GrokMessage[]}) {
  const { t } = useI18n();
  if (!messages.length) return <p>{t('play.grok.emptyChat')}</p>;
  return <ol className="grok-transcript">{messages.map((row, index) => <li key={index}>
    <strong>{t(row.role === 'user' ? 'play.grok.user' : 'play.grok.bot')}</strong>
    {row.timestamp !== undefined && <time>{new Date(row.timestamp).toLocaleString()}</time>}
    <MessageBody row={row} />
  </li>)}</ol>;
}

type Catalog = Awaited<ReturnType<typeof listGrokSessions>>;

function SessionChoices({catalog, select}: {catalog: Catalog | null; select: (session: GrokSession) => void}) {
  const { t } = useI18n();
  if (!catalog) return null;
  return <div>
    {catalog.failed > 0 && <p role="status">{t('play.grok.skipped', {count: catalog.failed})}</p>}
    {!catalog.sessions.length && <p>{t('play.grok.empty')}</p>}
    {catalog.sessions.map(session => <button key={session.file.name} className="list-item" onClick={() => select(session)}>{session.title}</button>)}
  </div>;
}

export function GrokHistorySource() {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState<GrokSession | null>(null);
  const [messages, setMessages] = useState<GrokMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function load(operation: () => Promise<() => void>) {
    const version = ++revision.current;
    setBusy(true);
    setError(false);
    try {
      const apply = await operation();
      if (revision.current === version) apply();
    } catch {
      if (revision.current === version) setError(true);
    } finally {
      if (revision.current === version) setBusy(false);
    }
  }

  function choose(files: File[]) {
    setSelected(null);
    setCatalog(null);
    void load(async () => {
      const result = await listGrokSessions(files);
      return () => setCatalog(result);
    });
  }

  async function loadDirectory(directory: GrokDirectory) {
    const result = await listGrokSessions(await replicaFiles(directory));
    return () => { setCatalog(result); setSelected(null); };
  }

  function openSource() {
    dialog.current?.showModal();
    back();
    void load(async () => {
      const directory = await rememberedDirectory().catch(() => undefined);
      if (directory && await directory.queryPermission({mode: 'read'}) === 'granted') return loadDirectory(directory);
      return () => {};
    });
  }

  async function pickDirectory() {
    const pick = directoryPicker();
    if (!pick) { picker.current?.click(); return; }
    try {
      const directory = await pick({mode: 'read', id: 'grok-history'});
      void rememberedDirectory(directory).catch(() => undefined);
      void load(() => loadDirectory(directory));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      picker.current?.click();
    }
  }

  function select(session: GrokSession) {
    setSelected(session);
    setMessages([]);
    void load(async () => {
      const result = readGrokHistory(JSON.parse(await session.file.text()));
      return () => setMessages(result);
    });
  }

  function back() {
    revision.current++;
    setSelected(null);
    setError(false);
    setBusy(false);
  }

  function renderContent() {
    if (busy) return <p role="status">{t('common.loading')}</p>;
    if (error) return <p role="alert">{t('play.grok.failed')}</p>;
    if (selected) return <Transcript messages={messages} />;
    return <SessionChoices catalog={catalog} select={select} />;
  }

  return <>
    <button type="button" className="btn btn-ghost" onClick={openSource}>{t('play.grok.source')}</button>
    <dialog ref={dialog} className="grok-history" aria-label={t('play.grok.source')}>
      <header><h3>{selected?.title ?? t('play.grok.source')}</h3>
        <button className="btn btn-ghost" onClick={() => dialog.current?.close()}>{t('common.close')}</button></header>
      {selected ? <button className="btn btn-ghost" onClick={back}>{t('play.grok.back')}</button> :
        <div><p>{t('play.grok.directory')}</p><code>~/Library/Application Support/Grok Bot/sand-client-persistence</code>
          <p><button className="btn" onClick={pickDirectory}>{t('play.grok.choose')}</button></p>
          <input hidden ref={picker} type="file" multiple {...{webkitdirectory: ''}} onChange={event => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            choose(files);
          }} /></div>}
      {renderContent()}
    </dialog>
  </>;
}
