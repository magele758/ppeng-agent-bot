'use client';

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import type { LibraryPageDetail, LibraryPageSummary } from './library-pages-model.ts';
import {
  applyCreate,
  applyDelete,
  applyRotate,
  applyUpdate,
  copySharePath,
  createPage,
  deletePage,
  loadPages,
  openPage,
  rotatePageShare,
  updatePage
} from './library-pages-actions.ts';

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

function usePageList(t: TFn) {
  const [pages, setPages] = useState<LibraryPageSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    const result = await loadPages(api);
    if ('error' in result) {
      setErr(t('knowledge.pages.loadFailed', { error: result.error }));
      return;
    }
    setPages(result.pages);
    setLoaded(true);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return { pages, setPages, loaded, err, setErr, load };
}

function usePageDetail(t: TFn, setErr: (v: string | null) => void) {
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LibraryPageDetail | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const open = async (id: string) => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    const result = await openPage(api, id);
    setBusy(false);
    if ('error' in result) {
      setErr(t('knowledge.pages.openFailed', { error: result.error }));
      return;
    }
    setSelectedId(id);
    setDetail(result.page);
  };

  const back = () => {
    setSelectedId(null);
    setDetail(null);
    setMsg(null);
    setErr(null);
  };

  return { busy, setBusy, selectedId, setSelectedId, detail, setDetail, msg, setMsg, open, back };
}

function usePageShare(
  t: TFn,
  setPages: Dispatch<SetStateAction<LibraryPageSummary[]>>,
  setBusy: (v: boolean) => void,
  setMsg: (v: string | null) => void,
  setErr: (v: string | null) => void,
  setSelectedId: (v: string | null) => void,
  setDetail: (v: LibraryPageDetail | null) => void
) {
  const copyShare = async (sharePath: string) => {
    setMsg(null);
    setErr(null);
    const result = await copySharePath((text) => navigator.clipboard.writeText(text), sharePath);
    if ('error' in result) {
      setErr(t('knowledge.pages.copyFailed', { error: result.error }));
      return;
    }
    setMsg(t('knowledge.pages.copied'));
  };

  const rotate = async (id: string) => {
    if (!window.confirm(t('knowledge.pages.rotateConfirm'))) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    const result = await rotatePageShare(api, id);
    setBusy(false);
    if ('error' in result) {
      setErr(t('knowledge.pages.rotateFailed', { error: result.error }));
      return;
    }
    setPages((prev) => applyRotate(prev, result.page));
    setDetail(result.page);
    setMsg(t('knowledge.pages.rotated'));
  };

  const remove = async (id: string) => {
    if (!window.confirm(t('knowledge.pages.deleteConfirm'))) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    const result = await deletePage(api, id);
    setBusy(false);
    if ('error' in result) {
      setErr(t('knowledge.pages.deleteFailed', { error: result.error }));
      return;
    }
    setPages((prev) => applyDelete(prev, id));
    setSelectedId(null);
    setDetail(null);
    setMsg(t('knowledge.pages.deleted'));
  };

  return { copyShare, rotate, remove };
}

function usePageCreate(
  t: TFn,
  setPages: Dispatch<SetStateAction<LibraryPageSummary[]>>,
  setBusy: (v: boolean) => void,
  setMsg: (v: string | null) => void,
  setErr: (v: string | null) => void,
  setSelectedId: (v: string | null) => void,
  setDetail: (v: LibraryPageDetail | null) => void
) {
  const create = async (title: string, markdown: string) => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    const result = await createPage(api, title, markdown);
    setBusy(false);
    if ('error' in result) {
      setErr(t('knowledge.pages.createFailed', { error: result.error }));
      return;
    }
    setPages((prev) => applyCreate(prev, result.page));
    setSelectedId(result.page.id);
    setDetail(result.page);
    setMsg(t('knowledge.pages.created'));
  };

  return { create };
}

function usePageUpdate(
  t: TFn,
  setPages: Dispatch<SetStateAction<LibraryPageSummary[]>>,
  setBusy: (v: boolean) => void,
  setMsg: (v: string | null) => void,
  setErr: (v: string | null) => void,
  setDetail: (v: LibraryPageDetail | null) => void
) {
  const update = async (id: string, updates: { title?: string; markdown?: string }) => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    const result = await updatePage(api, id, updates);
    setBusy(false);
    if ('error' in result) {
      setErr(t('knowledge.pages.updateFailed', { error: result.error }));
      return;
    }
    setPages((prev) => applyUpdate(prev, result.page));
    setDetail(result.page);
    setMsg(t('knowledge.pages.saved'));
  };

  return { update };
}

export function useLibraryPages() {
  const { t } = useI18n();
  const list = usePageList(t);
  const detail = usePageDetail(t, list.setErr);
  const share = usePageShare(
    t,
    list.setPages,
    detail.setBusy,
    detail.setMsg,
    list.setErr,
    detail.setSelectedId,
    detail.setDetail
  );
  const creator = usePageCreate(
    t,
    list.setPages,
    detail.setBusy,
    detail.setMsg,
    list.setErr,
    detail.setSelectedId,
    detail.setDetail
  );
  const updater = usePageUpdate(
    t,
    list.setPages,
    detail.setBusy,
    detail.setMsg,
    list.setErr,
    detail.setDetail
  );
  return {
    t,
    pages: list.pages,
    loaded: list.loaded,
    busy: detail.busy,
    selectedId: detail.selectedId,
    detail: detail.detail,
    msg: detail.msg,
    err: list.err,
    load: list.load,
    open: detail.open,
    back: detail.back,
    copyShare: share.copyShare,
    rotate: share.rotate,
    remove: share.remove,
    create: creator.create,
    update: updater.update
  };
}
