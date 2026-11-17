'use client';

import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { GlobalStatusBar } from '../GlobalStatusBar';
import { useLab } from './LabProvider';

/** 非对话页顶部的薄状态条：服务端信息 + 全局状态 + 刷新/自动刷新/调度 */
export function ShellToolbar() {
  const { t } = useI18n();
  const { serverMeta, autoRefresh, setAutoRefresh, tick } = useLab();
  return (
    <div className="lab-toolbar" id="serverMeta">
      {serverMeta ? (
        <>
          <span className="lab-toolbar__meta">
            {serverMeta.name} v{serverMeta.version}
          </span>
          {serverMeta.adapter ? <span>{serverMeta.adapter}</span> : null}
        </>
      ) : (
        <span className="meta-quiet--warn">{t('nav.apiUnavailable')}</span>
      )}
      <GlobalStatusBar />
      <span className="lab-toolbar__spacer" />
      <label className="toggle toggle--compact" title={t('nav.autoRefreshHint')}>
        <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
        <span>{t('nav.autoRefresh')}</span>
      </label>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void tick({ includePlayPanel: true })}>
        {t('common.refresh')}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => void api('/api/scheduler/run', { method: 'POST' }).then(() => tick())}
      >
        {t('nav.scheduler')}
      </button>
    </div>
  );
}
