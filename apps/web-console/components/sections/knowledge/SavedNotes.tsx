'use client';

import { useEffect, useState } from 'react';
import styles from './knowledge.module.css';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';

interface Note {title:string;file:string;vault:string;topics:string[]}
function byTopic(notes: Note[]) {
  const groups = new Map<string, Note[]>();
  for (const note of notes) for (const topic of note.topics) {
    const members = groups.get(topic) ?? [];
    members.push(note);
    groups.set(topic,members);
  }
  return groups;
}

export function SavedNotes() {
  const {t} = useI18n();
  return <><a href="#/settings/integrations">{t('knowledge.vault.title')}</a><NoteGraph /></>;
}

function NoteGraph() {
  const {t} = useI18n();
  const [notes,setNotes] = useState<Note[]>();
  const [selected,setSelected] = useState<string | null>(null);
  const [failed,setFailed] = useState(false);
  useEffect(()=>{
    let active = true;
    api('/api/obsidian/notes').then(data=>{ if (active) setNotes((data as {notes:Note[]}).notes); })
      .catch(()=>{ if (active) setFailed(true); });
    return ()=>{ active=false; };
  },[]);
  if (failed) return <p role="alert">{t('knowledge.notes.failed')}</p>;
  if (!notes) return <p>{t('knowledge.notes.loading')}</p>;
  if (!notes.length) return <p>{t('knowledge.notes.empty')}</p>;
  const groups = byTopic(notes);
  const topic = selected ?? notes[0]!.topics[0]!;
  const members = groups.get(topic) ?? [];
  const related = new Set(members.flatMap(note=>note.topics).filter(key=>key!==topic));
  const label = (key:string)=>t(('knowledge.notes.'+key) as MessageKey);
  return <div className={styles.noteGraph}>
    <nav className={styles.noteSubjects} aria-label={t('knowledge.notes.subjects')}>
      {[...groups].map(([key,items])=><button type="button" key={key} aria-pressed={key===topic}
        className="btn btn-ghost" onClick={()=>setSelected(key)}>{label(key)} · {items.length}</button>)}
    </nav>
    <section>
      <h3>{label(topic)}</h3>
      <ul className={styles.noteEdges}>{members.map(note=><li key={note.vault+'/'+note.file}>
        <a href={'obsidian://open?'+new URLSearchParams({vault:note.vault,file:note.file})}>{note.title}</a>
      </li>)}</ul>
      {related.size>0 && <div><small>{t('knowledge.notes.related')}</small>
        <div className={styles.noteSubjects}>{[...related].map(key=><button className="btn btn-ghost"
          type="button" key={key} onClick={()=>setSelected(key)}>{label(key)}</button>)}</div>
      </div>}
    </section>
  </div>;
}
