'use client';

import { useState } from 'react';
import { approvalInboxStatusText } from '@/lib/approval-inbox';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { sortAgentsById } from '@/lib/sort-utils';
import { EmptyState, SettingsGroup } from '../../ui';
import { useLab } from '../../shell/LabProvider';
import styles from './tasks.module.css';

/** 待审批工具调用、站内邮件与工作区 */
export function InboxView() {
  const { t } = useI18n();
  const { approvals, workspaces, agents, mailAll, tick, navigate, openSession } = useLab();
  const [mailFrom, setMailFrom] = useState('');
  const [mailTo, setMailTo] = useState('');
  const [mailBody, setMailBody] = useState('');
  const agentsSorted = sortAgentsById(agents);
  const onRefresh = () => void tick();

  const decide = (id: string, verdict: 'approve' | 'reject') =>
    void api(`/api/approvals/${id}/${verdict}`, { method: 'POST' }).then(onRefresh);

  const handleSendMail = async () => {
    const body = mailBody.trim();
    if (!body) return;
    await api('/api/mailbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromAgentId: mailFrom || agentsSorted[0]?.id,
        toAgentId: mailTo || agentsSorted[0]?.id,
        content: body
      })
    });
    await api('/api/scheduler/run', { method: 'POST' });
    setMailBody('');
    onRefresh();
    navigate('agents', 'teams');
  };

  const recentMail = mailAll.slice(-5).reverse();

  return (
    <>
      <SettingsGroup title={t('tasks.inbox.approvalsTitle')} description={t('tasks.inbox.approvalsDesc')}>
        {approvals.length === 0 ? (
          <EmptyState title={t('tasks.inbox.approvalsEmptyTitle')} description={t('tasks.inbox.approvalsEmptyDesc')} />
        ) : (
          <div id="listApprovals" className={styles.list}>
            {approvals.map((a) => {
              const expiryNote = approvalInboxStatusText(a, t);
              const expired = Boolean(a.expireReason);
              return (
                <div key={a.id} className={`list-item ${styles.row}`}>
                  <div className={styles.rowMain}>
                    <strong>{a.toolName}</strong>
                  </div>
                  <div className={styles.rowMeta}>
                    <span>{t('tasks.inbox.reason', { reason: a.reason || t('tasks.inbox.noReason') })}</span>
                    <span>{t('tasks.inbox.session', { id: a.sessionId })}</span>
                    {expiryNote ? <span>{expiryNote}</span> : null}
                  </div>
                  <div className={styles.actions}>
                    {expired ? null : (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          aria-label={t('tasks.inbox.approveAria', { tool: a.toolName })}
                          onClick={() => decide(a.id, 'approve')}
                        >
                          {t('tasks.inbox.approve')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={t('tasks.inbox.rejectAria', { tool: a.toolName })}
                          onClick={() => decide(a.id, 'reject')}
                        >
                          {t('tasks.inbox.reject')}
                        </button>
                      </>
                    )}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openSession(a.sessionId, { focusChat: true })}>
                      {t('tasks.openSession')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title={t('tasks.inbox.mailTitle')} description={t('tasks.inbox.mailDesc')} collapsible defaultOpen={false}>
        {agentsSorted.length === 0 ? (
          <EmptyState title={t('tasks.inbox.mailNoAgents')} />
        ) : (
          <>
            <div className={styles.mailGrid}>
              <label className={styles.field}>
                <span>{t('tasks.inbox.mailFrom')}</span>
                <select id="mailFrom" value={mailFrom} onChange={(e) => setMailFrom(e.target.value)}>
                  {agentsSorted.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span>{t('tasks.inbox.mailTo')}</span>
                <select id="mailTo" value={mailTo} onChange={(e) => setMailTo(e.target.value)}>
                  {agentsSorted.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`${styles.field} ${styles.mailBody}`}>
                <span>{t('tasks.inbox.mailBody')}</span>
                <textarea
                  id="mailBody"
                  rows={2}
                  placeholder={t('tasks.inbox.mailBodyPh')}
                  value={mailBody}
                  onChange={(e) => setMailBody(e.target.value)}
                />
              </label>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className="btn btn-primary"
                id="btnSendMail"
                disabled={!mailBody.trim()}
                onClick={() => void handleSendMail()}
              >
                {t('tasks.inbox.mailSend')}
              </button>
            </div>
            <h3 className={styles.field}>{t('tasks.inbox.recentMail')}</h3>
            {recentMail.length === 0 ? (
              <p className="muted">{t('tasks.inbox.recentMailEmpty')}</p>
            ) : (
              <div className={styles.list}>
                {recentMail.map((m, i) => (
                  <div key={`${m.createdAt}-${i}`} className={`list-item ${styles.row}`}>
                    <div className={styles.rowMeta}>
                      <span>
                        {m.fromAgentId} → {m.toAgentId}
                      </span>
                      <span>{m.status}</span>
                    </div>
                    <div>{m.content.slice(0, 160)}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title={t('tasks.inbox.workspacesTitle')} description={t('tasks.inbox.workspacesDesc')} collapsible defaultOpen={false}>
        {workspaces.length === 0 ? (
          <EmptyState title={t('tasks.inbox.workspacesEmptyTitle')} description={t('tasks.inbox.workspacesEmptyDesc')} />
        ) : (
          <div id="listWorkspaces" className={styles.list}>
            {workspaces.map((w, i) => (
              <div key={`ws-${i}-${w.name}`} className={`list-item ${styles.row}`}>
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>{w.name}</span>
                  {w.mode ? <span className={styles.status}>{w.mode}</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsGroup>
    </>
  );
}
