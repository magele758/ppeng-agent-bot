'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Snapshot {
  settings: unknown;
  effective: unknown;
  error: string | null;
}

interface Store {
  snapshot: Snapshot;
  listeners: Set<() => void>;
}

const EMPTY: Snapshot = { settings: null, effective: null, error: null };
const stores = new Map<string, Store>();

function getStore(path: string): Store {
  let store = stores.get(path);
  if (!store) {
    store = { snapshot: EMPTY, listeners: new Set() };
    stores.set(path, store);
  }
  return store;
}

function publish(store: Store, snapshot: Snapshot) {
  store.snapshot = snapshot;
  store.listeners.forEach((l) => l());
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function optimisticValue(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value) ||
    (Array.isArray(value) && value.every(item => ['string', 'number', 'boolean'].includes(typeof item)));
}

/** 对原始值与原始值数组做乐观更新（开关立即翻转）；嵌套对象等待服务端结果 */
function optimisticPatch(current: unknown, patch: Record<string, unknown>): Record<string, unknown> | null {
  if (!current || typeof current !== 'object') return null;
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (optimisticValue(v)) flat[k] = Array.isArray(v) ? [...v] : v;
  }
  return Object.keys(flat).length > 0 ? { ...(current as Record<string, unknown>), ...flat } : null;
}

export type SettingsStatus = { kind: 'ok' | 'err'; text: string } | null;

export interface SettingsResource<S, E> {
  settings: S | null;
  effective: E | null;
  loadError: string | null;
  busy: boolean;
  status: SettingsStatus;
  reload: () => Promise<void>;
  /** PATCH；成功返回 true。同一路径的所有卡片共享最新值 */
  save: (patch: Record<string, unknown>) => Promise<boolean>;
  setStatus: (status: SettingsStatus) => void;
  /** 在已保存之外自定义一次异步动作（探测等），统一处理 busy 与错误 */
  run: <T>(action: () => Promise<T>, okText?: (result: T) => string | null) => Promise<T | undefined>;
}

/**
 * 同一个 daemon settings 路径只保留一份状态，被拆分到多个设置条目的卡片能互相同步。
 * 约定：响应形如 `{ settings, effective? }`，保存用 PATCH。
 */
export function useSettingsResource<S, E = unknown>(path: string): SettingsResource<S, E> {
  const { t } = useI18n();
  const store = getStore(path);
  const snap = useSyncExternalStore(
    (cb) => {
      store.listeners.add(cb);
      return () => store.listeners.delete(cb);
    },
    () => store.snapshot,
    () => EMPTY
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SettingsStatus>(null);

  const reload = useCallback(async () => {
    try {
      const data = (await api(path)) as { settings: unknown; effective?: unknown };
      publish(store, { settings: data.settings, effective: data.effective ?? null, error: null });
    } catch (e) {
      publish(store, { ...store.snapshot, error: errorText(e) });
    }
  }, [path, store]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, okText?: (result: T) => string | null) => {
      setBusy(true);
      setStatus(null);
      try {
        const result = await action();
        const text = okText ? okText(result) : null;
        if (text) setStatus({ kind: 'ok', text });
        return result;
      } catch (e) {
        setStatus({ kind: 'err', text: errorText(e) });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      const before = store.snapshot;
      const optimistic = optimisticPatch(before.settings, patch);
      if (optimistic) publish(store, { ...before, settings: optimistic });
      let applyAt: unknown;
      const result = await run(
        async () => {
          const data = (await api(path, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
          })) as { settings: unknown; effective?: unknown };
          applyAt = (data.effective as {applyAt?:string}|undefined)?.applyAt;
          publish(store, {
            settings: data.settings,
            effective: data.effective ?? store.snapshot.effective,
            error: null
          });
          return true;
        },
        () => t(path === '/api/loop/settings' ? 'botSettings.loopHint' : applyAt === 'next-step' ? 'botSettings.nextStep' : applyAt === 'next-run' ? 'botSettings.nextRun' : 'settingsEntries.common.saved')
      );
      if (result !== true && store.snapshot.settings === optimistic) publish(store, before);
      return result === true;
    },
    [path, run, store, t]
  );

  return {
    settings: snap.settings as S | null,
    effective: snap.effective as E | null,
    loadError: snap.error,
    busy,
    status,
    reload,
    save,
    setStatus,
    run
  };
}
