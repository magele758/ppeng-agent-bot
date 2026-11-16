'use client';

import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

type Attachment = {
  id: string;
  fileName: string;
  kind: string;
  status: string;
  statusReason?: string;
  localRelPath?: string;
  imageAssetId?: string;
};
type Input = { fileName?: string; mimeType?: string; dataBase64?: string; url?: string };

function fileInput(file: File): Promise<Input> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        fileName: file.name,
        mimeType: file.type,
        dataBase64: String(reader.result).split(',')[1]
      });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function useChatAttachments(options: {
  ensureSession(): Promise<string>;
  activeSession(): string | null;
  draftKey: string;
  add(id: string): void;
  report(status: { text: string; ok?: boolean; err?: boolean }): void;
}) {
  const { t } = useI18n();
  const [count, setCount] = useState(0);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const pending = useRef(0);
  const sessions = useRef(new Map<string, Promise<string>>());

  function sessionForDraft() {
    const key = options.draftKey;
    const requests = sessions.current;
    const existing = requests.get(key);
    if (existing) return existing;
    const request = options.ensureSession().finally(() => requests.delete(key));
    requests.set(key, request);
    return request;
  }

  async function ingest(sid: string, input: Input) {
    const route = input.url ? 'fetch-url' : 'ingest-base64';
    const { attachment } = (await api('/api/sessions/' + sid + '/attachments/' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    })) as { attachment: Attachment };
    assertStored(attachment);
    if (options.activeSession() !== sid) return;
    const notice = availabilityNotice(attachment);
    const name = attachment.fileName + ' · ' + attachment.id.slice(-8);
    setLabels((current) => ({ ...current, [attachment.id]: [name, notice].filter(Boolean).join(' · ') }));
    options.add(attachment.id);
    return notice;
  }

  function assertStored(attachment: Attachment) {
    const stored = attachment.localRelPath || attachment.imageAssetId;
    if (attachment.status === 'failed' || !stored) {
      throw new Error(attachment.statusReason ?? t('play.status.uploadFailed'));
    }
  }

  function availabilityNotice(attachment: Attachment) {
    if (attachment.status === 'degraded') return attachment.statusReason || t('play.status.originalOnly');
    if (attachment.fileName.toLowerCase().endsWith('.pdf')) return t('play.status.originalOnly');
  }

  async function ingestBatch(
    sid: string,
    inputs: Array<() => Promise<Input>>,
    warnings: string[],
    errors: string[]
  ) {
    for (const getInput of inputs) {
      try {
        const warning = await ingest(sid, await getInput());
        if (warning) warnings.push(warning);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const queues = useRef(new Map<string, Promise<void>>());

  async function enqueue(sid: string, task: () => Promise<void>) {
    const previous = queues.current.get(sid) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.current.set(sid, next);
    try {
      await next;
    } finally {
      if (queues.current.get(sid) === next) queues.current.delete(sid);
    }
  }

  async function upload(inputs: Array<() => Promise<Input>>) {
    options.report({ text: t('play.status.uploadingFiles') });
    const errors: string[] = [];
    const warnings: string[] = [];
    pending.current++;
    setCount((n) => n + 1);
    try {
      const sid = await sessionForDraft();
      await enqueue(sid, () => ingestBatch(sid, inputs, warnings, errors));
      if (options.activeSession() !== sid) return;
      const message =
        [...errors, ...warnings].join(' · ') || t('play.status.addedFiles', { count: inputs.length });
      options.report({ text: message, err: errors.length > 0, ok: errors.length === 0 });
      return errors.length === 0;
    } catch (error) {
      options.report({ text: String(error), err: true });
    } finally {
      pending.current--;
      setCount((n) => n - 1);
    }
  }

  return {
    labels,
    uploading: count > 0,
    isUploading: () => pending.current > 0,
    files: (files: FileList | File[]) => upload(Array.from(files, (file) => () => fileInput(file))),
    url: (url: string) => upload([async () => ({ url })])
  };
}
