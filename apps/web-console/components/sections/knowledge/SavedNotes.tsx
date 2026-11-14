'use client';

import { useEffect, useState } from 'react';
import styles from './knowledge.module.css';
import { api } from '@/lib/api';
import { useI18n, type I18nContextValue, type MessageKey } from '@/lib/i18n';

interface Note { title: string; file: string; vault: string; topics: string[] }

function byTopic(notes: Note[]) {
  const groups = new Map<string, Note[]>();
  for (const note of notes) for (const topic of note.topics) {
    const members = groups.get(topic) ?? [];
    members.push(note);
    groups.set(topic, members);
  }
  return groups;
}

type Translate = I18nContextValue['t'];
type NotePhase = 'failed' | 'loading' | 'empty' | 'ready';

function notePhase(failed: boolean, notes: Note[] | undefined): NotePhase {
  if (failed) return 'failed';
  if (!notes) return 'loading';
  if (!notes.length) return 'empty';
  return 'ready';
}

function NotePhaseMessage({ phase, t }: { phase: Exclude<NotePhase, 'ready'>; t: Translate }) {
  if (phase === 'failed') return <p role="alert">{t('knowledge.notes.failed')}</p>;
  if (phase === 'loading') return <p>{t('knowledge.notes.loading')}</p>;
  return <p>{t('knowledge.notes.empty')}</p>;
}

function relatedTopics(members: Note[], topic: string) {
  return [...new Set(members.flatMap(note => note.topics).filter(key => key !== topic))];
}

function RelatedTopics({ related, label, onSelect, t }: {
  related: string[];
  label: (key: string) => string;
  onSelect: (key: string) => void;
  t: Translate;
}) {
  if (related.length === 0) return null;
  return <div>
    <small>{t('knowledge.notes.related')}</small>
    <div className={styles.noteSubjects}>
      {related.map(key => <button className="btn btn-ghost" type="button" key={key} onClick={() => onSelect(key)}>{label(key)}</button>)}
    </div>
  </div>;
}

function NoteGraphBody({ notes, selected, onSelect, t }: {
  notes: Note[];
  selected: string | null;
  onSelect: (key: string) => void;
  t: Translate;
}) {
  const groups = byTopic(notes);
  const topic = selected ?? notes[0]!.topics[0]!;
  const members = groups.get(topic) ?? [];
  const related = relatedTopics(members, topic);
  const label = (key: string) => t(('knowledge.notes.' + key) as MessageKey);
  return <div className={styles.noteGraph}>
    <nav className={styles.noteSubjects} aria-label={t('knowledge.notes.subjects')}>
      {[...groups].map(([key, items]) => <button type="button" key={key} aria-pressed={key === topic}
        className="btn btn-ghost" onClick={() => onSelect(key)}>{label(key)} · {items.length}</button>)}
    </nav>
    <section>
      <h3>{label(topic)}</h3>
      <ul className={styles.noteEdges}>{members.map(note => <li key={note.vault + '/' + note.file}>
        <a href={'obsidian://open?' + new URLSearchParams({ vault: note.vault, file: note.file })}>{note.title}</a>
      </li>)}</ul>
      <RelatedTopics related={related} label={label} onSelect={onSelect} t={t} />
    </section>
  </div>;
}

function NoteGraph() {
  const { t } = useI18n();
  const [notes, setNotes] = useState<Note[]>();
  const [selected, setSelected] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    api('/api/obsidian/notes').then(data => {
      if (!active) return;
      const payload = data as { notes: Note[] };
      setNotes(payload.notes);
    })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);
  const phase = notePhase(failed, notes);
  if (phase !== 'ready') return <NotePhaseMessage phase={phase} t={t} />;
  return <NoteGraphBody notes={notes!} selected={selected} onSelect={setSelected} t={t} />;
}

export function SavedNotes() {
  const { t } = useI18n();
  return <><a href="#/settings/integrations">{t('knowledge.vault.title')}</a><NoteGraph /></>;
}
