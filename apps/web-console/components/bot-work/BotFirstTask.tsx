'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { botConnectionsHref } from '@/lib/bot-recovery-link';

export function BotFirstTask({ botId, needsModel, onChoose, onConfigureModel, onDismiss }: {
  botId: string; needsModel: boolean; onChoose: (text: string) => void; onConfigureModel: () => void; onDismiss?: () => void;
}) {
  const { t } = useI18n();
  const storageKey = 'lab.botFirstTaskDismissed.' + botId;
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  useEffect(() => {
    try { setDismissed(localStorage.getItem(storageKey) === '1'); }
    catch { setDismissed(false); }
    setStorageFailed(false);
  }, [storageKey]);
  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(storageKey, '1'); }
    catch { setStorageFailed(true); }
    onDismiss?.();
  }
  if (dismissed !== false) return storageFailed ? <p role="status">{t('botWork.firstTaskDismissStorageError')}</p> : null;
  return <section data-testid="bot-first-task" className="ag-panel">
    <div className="ag-panel__head">
      <h3>{t('botWork.firstTaskTitle')}</h3>
      <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>{t('botWork.firstTaskDismiss')}</button>
    </div>
    <p>{t('botWork.firstTaskHint')}</p>
    {needsModel && <p role="status">{t('botWork.firstTaskNeedsModel')} <button type="button" onClick={onConfigureModel}>{t('botWork.configureModel')}</button></p>}
    <button type="button" onClick={() => onChoose(t('botWork.firstTaskMaterialPrompt'))}>{t('botWork.firstTaskMaterials')}</button>
    <button type="button" onClick={() => onChoose(t('botWork.firstTaskPlanPrompt'))}>{t('botWork.firstTaskPlan')}</button>
    <p>{t('botWork.firstTaskConnectionsHint')} <a href={botConnectionsHref(botId)}>{t('botWork.checkSoftware')}</a></p>
  </section>;
}
