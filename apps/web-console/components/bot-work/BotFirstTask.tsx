'use client';
import { useI18n } from '@/lib/i18n';
import { botConnectionsHref } from '@/lib/bot-recovery-link';

export function BotFirstTask({ botId, needsModel, onChoose, onConfigureModel }: {
  botId: string; needsModel: boolean; onChoose: (text: string) => void; onConfigureModel: () => void;
}) {
  const { t } = useI18n();
  return <section data-testid="bot-first-task" className="ag-panel">
    <h3>{t('botWork.firstTaskTitle')}</h3>
    <p>{t('botWork.firstTaskHint')}</p>
    {needsModel && <p role="status">{t('botWork.firstTaskNeedsModel')} <button type="button" onClick={onConfigureModel}>{t('botWork.configureModel')}</button></p>}
    <button type="button" onClick={() => onChoose(t('botWork.firstTaskMaterialPrompt'))}>{t('botWork.firstTaskMaterials')}</button>
    <button type="button" onClick={() => onChoose(t('botWork.firstTaskPlanPrompt'))}>{t('botWork.firstTaskPlan')}</button>
    <p>{t('botWork.firstTaskConnectionsHint')} <a href={botConnectionsHref(botId)}>{t('botWork.checkSoftware')}</a></p>
  </section>;
}
