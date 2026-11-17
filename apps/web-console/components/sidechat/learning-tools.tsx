'use client';
import { useState } from 'react';
import type { SidechatGrasp, SidechatMessage } from '@ppeng/api-types';
import { useI18n } from '@/lib/i18n';
import { distillSidechat, updateSidechat, type SidechatDetail } from '@/lib/sidechat-api';
import { nextTitle } from '@/lib/sidechat-learning';

type Updated = (detail: SidechatDetail) => void;
type Copy = (key: 'sidechat.noteError' | 'sidechat.distillNeedsReply' | 'sidechat.distillError') => string;

export function LearningBar({
  detail,
  ask,
  onUpdated
}: {
  detail?: SidechatDetail;
  ask: (text: string) => void;
  onUpdated: Updated;
}) {
  return (
    <div className="sc-learning">
      <PromptChips ask={ask} busy={isGenerating(detail)} />
      {detail ? <SavedLearning detail={detail} onUpdated={onUpdated} /> : null}
    </div>
  );
}

export function ReplyActions({ message, onCite }: { message: SidechatMessage; onCite?: (text: string) => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  if (!onCite || !readyReply(message)) return null;
  return (
    <div className="sc-reply-actions">
      <button type="button" data-testid="sidechat-copy-reply" onClick={() => void copyReply(message.text, setCopied)}>
        {t(copied ? 'sidechat.copied' : 'sidechat.copy')}
      </button>
      <button type="button" data-testid="sidechat-cite" onClick={() => onCite(message.text)}>
        {t('sidechat.cite')}
      </button>
    </div>
  );
}

function PromptChips({ ask, busy }: { ask: (text: string) => void; busy: boolean }) {
  const { t } = useI18n();
  return (
    <div className="sc-chips">
      <Chip id="analogy" label={t('sidechat.analogy')} prompt={t('sidechat.analogyPrompt')} ask={ask} busy={busy} />
      <Chip id="example" label={t('sidechat.example')} prompt={t('sidechat.examplePrompt')} ask={ask} busy={busy} />
      <Chip id="deep" label={t('sidechat.deep')} prompt={t('sidechat.deepPrompt')} ask={ask} busy={busy} />
    </div>
  );
}

function Chip({
  id,
  label,
  prompt,
  ask,
  busy
}: {
  id: string;
  label: string;
  prompt: string;
  ask: (text: string) => void;
  busy: boolean;
}) {
  return (
    <button type="button" data-testid={'sidechat-chip-' + id} disabled={busy} onClick={() => ask(prompt)}>
      {label}
    </button>
  );
}

function SavedLearning({ detail, onUpdated }: { detail: SidechatDetail; onUpdated: Updated }) {
  return (
    <div className="sc-saved-learning">
      <GraspToggle detail={detail} onUpdated={onUpdated} />
      <NoteBox detail={detail} onUpdated={onUpdated} />
      <RenameButton detail={detail} onUpdated={onUpdated} />
    </div>
  );
}

function GraspToggle({ detail, onUpdated }: { detail: SidechatDetail; onUpdated: Updated }) {
  const { t } = useI18n();
  const [fault, setFault] = useState(false);
  const mastered = detail.thread.grasp === 'mastered';
  return (
    <>
      <button
        type="button"
        data-testid="sidechat-grasp"
        aria-pressed={mastered}
        onClick={() => void saveGrasp(detail.thread.id, mastered ? 'thinking' : 'mastered', onUpdated, setFault)}
      >
        {t(mastered ? 'sidechat.markThinking' : 'sidechat.markMastered')}
      </button>
      {fault ? <span role="alert">{t('sidechat.graspError')}</span> : null}
    </>
  );
}

function NoteBox({ detail, onUpdated }: { detail: SidechatDetail; onUpdated: Updated }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const [fault, setFault] = useState('');
  return (
    <div className="sc-note-box">
      <NoteText note={detail.thread.note} />
      <NoteDraft draft={draft} setDraft={setDraft} />
      <button type="button" data-testid="sidechat-distill" onClick={() => void runDistill(detail.thread.id, onUpdated, setFault, t)}>
        {t('sidechat.distill')}
      </button>
      <button type="button" data-testid="sidechat-note-edit" onClick={() => setDraft(detail.thread.note)}>
        {t('sidechat.noteEdit')}
      </button>
      <button type="button" data-testid="sidechat-note-clear" onClick={() => void saveNote(detail.thread.id, '', onUpdated, setFault, setDraft, t)}>
        {t('sidechat.noteClear')}
      </button>
      <NoteSave id={detail.thread.id} draft={draft} onUpdated={onUpdated} setFault={setFault} setDraft={setDraft} />
      {fault ? <span role="alert">{fault}</span> : null}
    </div>
  );
}

function NoteText({ note }: { note: string }) {
  if (!note) return null;
  return <p data-testid="sidechat-note">{note}</p>;
}

function NoteDraft({ draft, setDraft }: { draft: string | null; setDraft: (value: string) => void }) {
  const { t } = useI18n();
  if (draft === null) return null;
  return (
    <input
      data-testid="sidechat-note-input"
      aria-label={t('sidechat.note')}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

function NoteSave({
  id,
  draft,
  onUpdated,
  setFault,
  setDraft
}: {
  id: string;
  draft: string | null;
  onUpdated: Updated;
  setFault: (fault: string) => void;
  setDraft: (value: string | null) => void;
}) {
  const { t } = useI18n();
  if (draft === null) return null;
  return (
    <button type="button" data-testid="sidechat-note-save" onClick={() => void saveNote(id, draft, onUpdated, setFault, setDraft, t)}>
      {t('sidechat.noteSave')}
    </button>
  );
}

function RenameButton({ detail, onUpdated }: { detail: SidechatDetail; onUpdated: Updated }) {
  const { t } = useI18n();
  const [fault, setFault] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="sidechat-rename"
        onClick={() => void rename(detail, t('sidechat.renamePrompt'), onUpdated, setFault)}
      >
        {t('sidechat.rename')}
      </button>
      {fault ? <span role="alert">{t('sidechat.renameError')}</span> : null}
    </>
  );
}

function isGenerating(detail?: SidechatDetail) {
  if (!detail) return false;
  return detail.thread.status === 'generating';
}

function readyReply(message: SidechatMessage) {
  return message.role === 'assistant' && message.status === 'complete' && Boolean(message.text.trim());
}

async function copyReply(text: string, setCopied: (copied: boolean) => void) {
  await navigator.clipboard.writeText(text);
  setCopied(true);
}

async function saveGrasp(id: string, grasp: SidechatGrasp, onUpdated: Updated, setFault: (fault: boolean) => void) {
  setFault(false);
  try {
    onUpdated(await updateSidechat(id, { grasp }));
  } catch {
    setFault(true);
  }
}

async function saveNote(
  id: string,
  note: string,
  onUpdated: Updated,
  setFault: (fault: string) => void,
  setDraft: (value: string | null) => void,
  t: Copy
) {
  setFault('');
  try {
    onUpdated(await updateSidechat(id, { note: note.trim().slice(0, 300) }));
    setDraft(null);
  } catch {
    setFault(t('sidechat.noteError'));
  }
}

async function runDistill(id: string, onUpdated: Updated, setFault: (fault: string) => void, t: Copy) {
  setFault('');
  try {
    onUpdated(await distillSidechat(id));
  } catch (error) {
    setFault(noteFault(error, t('sidechat.distillNeedsReply'), t('sidechat.distillError')));
  }
}

function noteFault(error: unknown, needs: string, failed: string) {
  const message = error instanceof Error ? error.message : '';
  return message.includes('sidechat_note_needs_reply') ? needs : failed;
}

async function rename(detail: SidechatDetail, label: string, onUpdated: Updated, setFault: (fault: boolean) => void) {
  const title = nextTitle(window.prompt(label, detail.thread.title), detail.thread.title);
  if (!title) return;
  setFault(false);
  try {
    onUpdated(await updateSidechat(detail.thread.id, { title }));
  } catch {
    setFault(true);
  }
}
