'use client';

import { useCallback, useEffect, useState } from 'react';
import { BotSkillManager } from './BotSkillManager';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { parseRemindDraft, REMIND_MAX, REMIND_MIN } from '@/lib/skill-proposal-remind';

interface ProposalSettings {
  enabled: boolean;
  remindEveryNToolCalls: number;
  updatedAt: string;
}

interface SettingsResponse {
  settings: ProposalSettings;
  effective: { enabled: boolean; remindEveryNToolCalls: number; source: string };
}

interface ProposalSummary {
  id: string;
  installed?: boolean;
  ownerBotId?: string;
  sharedBotIds?: string[];
  blockedBotIds?: string[];
  name: string;
  description: string;
  sessionId: string;
  kind: 'new' | 'update';
  replaces?: { name: string; source?: string };
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
  createdAt: string;
  decidedAt?: string;
  rejectReason?: string;
  revokedAt?: string;
  bodyPreview: string;
  bodyChars: number;
}

interface ProposalFull extends Omit<ProposalSummary, 'bodyPreview' | 'bodyChars'> {
  body: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function SkillProposalsCard() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<ProposalSettings | null>(null);
  const [effective, setEffective] = useState<SettingsResponse['effective'] | null>(null);
  const [remindDraft, setRemindDraft] = useState('0');
  const [remindInvalid, setRemindInvalid] = useState(false);
  const [proposals, setProposals] = useState<ProposalSummary[]>([]);
  const [expanded, setExpanded] = useState<Record<string, string>>({});
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const data = (await api('/api/skill-proposals/settings')) as SettingsResponse;
      setSettings(data.settings);
      setEffective(data.effective);
      setRemindDraft(String(data.settings.remindEveryNToolCalls));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadProposals = useCallback(async () => {
    try {
      const data = (await api('/api/skill-proposals')) as { proposals?: ProposalSummary[] };
      setProposals(Array.isArray(data.proposals) ? data.proposals : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadProposals();
  }, [loadSettings, loadProposals]);

  const saveSettings = async (patch: Partial<ProposalSettings>) => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const data = (await api('/api/skill-proposals/settings', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(patch)
      })) as SettingsResponse;
      setSettings(data.settings);
      setEffective(data.effective);
      setRemindDraft(String(data.settings.remindEveryNToolCalls));
      setMsg(t('more.savedNoRestart'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      void loadSettings();
    } finally {
      setBusy(false);
    }
  };

  const toggleFull = async (row: ProposalSummary) => {
    if (expanded[row.id] !== undefined) {
      setExpanded(({ [row.id]: _drop, ...rest }) => rest);
      return;
    }
    setErr(null);
    try {
      const data = (await api(`/api/skill-proposals/${encodeURIComponent(row.id)}`)) as {
        proposal: ProposalFull;
      };
      setExpanded((prev) => ({ ...prev, [row.id]: data.proposal.body }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const dropRow = (id: string) => {
    setExpanded(({ [id]: _drop, ...rest }) => rest);
    setRejectReasons(({ [id]: _drop, ...rest }) => rest);
  };

  const decide = async (row: ProposalSummary, action: 'approve' | 'reject') => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const reason = (rejectReasons[row.id] ?? '').trim();
      const data = (await api(`/api/skill-proposals/${encodeURIComponent(row.id)}/${action}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(action === 'reject' && reason ? { reason } : {})
      })) as { shadowedBy?: string };
      const base =
        action === 'approve'
          ? t('skillProposals.approvedMsg', { name: row.name })
          : t('skillProposals.rejectedMsg', { name: row.name });
      setMsg(data.shadowedBy ? `${base} ${t('skillProposals.shadowedWarn')}` : base);
      dropRow(row.id);
      await loadProposals();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      await loadProposals();
    } finally {
      setBusy(false);
    }
  };


  const statusLabel = (status: ProposalSummary['status']): string => {
    switch (status) {
      case 'pending':
        return t('skillProposals.statusPending');
      case 'approved':
        return t('skillProposals.statusApproved');
      case 'rejected':
        return t('skillProposals.statusRejected');
      case 'revoked':
        return t('skillProposals.statusRevoked');
      default: {
        const unreachable: never = status;
        return unreachable;
      }
    }
  };

  if (!settings) {
    return (
      <div className="card" id="card-skill-proposals">
        <div className="card-head">
          <h3>{t('skillProposals.title')}</h3>
        </div>
        <div className="empty-hint">{err ?? t('common.loading')}</div>
      </div>
    );
  }

  const pending = proposals.filter((p) => p.status === 'pending');
  const approved = proposals.filter((p) => p.status === 'approved' && p.installed !== false);
  const decided = proposals.filter((p) => p.status === 'rejected' || p.status === 'revoked').slice(0, 10);

  return (
    <div className="card" id="card-skill-proposals">
      <div className="card-head">
        <h3>{t('skillProposals.title')}</h3>
        <span className="badge">{effective?.source === 'ui' ? t('more.sourceUi') : t('more.sourceDefault')}</span>
      </div>
      <p className="muted" style={{ fontSize: '0.8rem', marginTop: 0 }}>
        {t('skillProposals.desc')}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            aria-label={t('skillProposals.enable')}
            checked={settings.enabled}
            disabled={busy}
            onChange={(e) => void saveSettings({ enabled: e.target.checked })}
          />
          <span>{t('skillProposals.enable')}</span>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            {t('more.effectivePrefix')}
            {effective?.enabled ? t('more.on') : t('more.off')}
          </span>
        </label>
        <label className="field">
          <span>{t('skillProposals.remindLabel')}</span>
          <input
            type="number"
            min={REMIND_MIN}
            max={REMIND_MAX}
            value={remindDraft}
            disabled={busy || !settings.enabled}
            onChange={(e) => {
              setRemindDraft(e.target.value);
              setRemindInvalid(false);
            }}
            onBlur={() => {
              const n = parseRemindDraft(remindDraft);
              if (n === null) {
                setRemindInvalid(true);
                setRemindDraft(String(settings.remindEveryNToolCalls));
              } else if (n !== settings.remindEveryNToolCalls) {
                setRemindInvalid(false);
                void saveSettings({ remindEveryNToolCalls: n });
              } else {
                setRemindInvalid(false);
                setRemindDraft(String(n));
              }
            }}
          />
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            {t('skillProposals.remindHint')}
          </span>
          {remindInvalid ? (
            <span className="bot-cron-panel__err" role="alert" style={{ fontSize: '0.75rem' }}>
              {t('skillProposals.remindInvalid', { min: REMIND_MIN, max: REMIND_MAX })}
            </span>
          ) : null}
        </label>

        <div className="card-head" style={{ paddingLeft: 0 }}>
          <h4 style={{ margin: 0 }}>
            {t('skillProposals.pendingTitle')} ({pending.length})
          </h4>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadProposals()}>
            {t('skillProposals.refresh')}
          </button>
        </div>
        {!pending.length ? (
          <div className="empty-hint">{t('skillProposals.pendingEmpty')}</div>
        ) : (
          pending.map((row) => {
            const full = expanded[row.id];
            const isOpen = full !== undefined;
            return (
              <div key={row.id} className="list-item" data-testid={`skill-proposal-${row.name}`}>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <strong>{row.name}</strong>
                  <span className="badge">
                    {row.kind === 'update' ? t('skillProposals.kindUpdate') : t('skillProposals.kindNew')}
                  </span>
                  <span className="muted" style={{ fontSize: '0.75rem' }}>
                    {t('skillProposals.bodyChars', { count: row.bodyChars })}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>
                  {row.ownerBotId ? t('skillProposals.ownerBot', { name: row.ownerBotId }) : t('skillProposals.legacyShared')} · {t('skillProposals.fromSession', { session: row.sessionId })}
                </div>
                {row.replaces ? (
                  <div className="muted" style={{ fontSize: '0.75rem' }}>
                    {t('skillProposals.replaces', { name: row.replaces.name })}
                  </div>
                ) : null}
                <div className="muted" style={{ fontSize: '0.8rem' }}>
                  {row.description}
                </div>
                <pre
                  className="chat-tool-io__body"
                  style={{ maxHeight: isOpen ? 360 : 96, overflow: 'auto', whiteSpace: 'pre-wrap' }}
                  data-testid={`skill-proposal-body-${row.name}`}
                >
                  {isOpen ? full : row.bodyPreview}
                </pre>
                <label className="field" style={{ marginTop: 8 }}>
                  <span className="muted" style={{ fontSize: '0.75rem' }}>
                    {t('skillProposals.rejectReasonLabel')}
                  </span>
                  <input
                    type="text"
                    maxLength={500}
                    aria-label={t('skillProposals.rejectReasonLabel')}
                    placeholder={t('skillProposals.rejectReasonPlaceholder')}
                    value={rejectReasons[row.id] ?? ''}
                    disabled={busy}
                    onChange={(e) => setRejectReasons((prev) => ({ ...prev, [row.id]: e.target.value }))}
                  />
                </label>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void toggleFull(row)}
                  >
                    {isOpen ? t('skillProposals.hideFull') : t('skillProposals.showFull')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || !isOpen}
                    title={isOpen ? undefined : t('skillProposals.viewBeforeApprove')}
                    onClick={() => void decide(row, 'approve')}
                  >
                    {t('skillProposals.approve')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void decide(row, 'reject')}
                  >
                    {t('skillProposals.reject')}
                  </button>
                  {!isOpen ? (
                    <span className="muted" style={{ fontSize: '0.75rem' }}>
                      {t('skillProposals.viewBeforeApprove')}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
        <BotSkillManager skills={approved} onChange={loadProposals} />
        {decided.length ? (
          <>
            <div className="card-head" style={{ paddingLeft: 0 }}>
              <h4 style={{ margin: 0 }}>{t('skillProposals.decidedTitle')}</h4>
            </div>
            {decided.map((row) => (
              <div
                key={row.id}
                className="muted"
                style={{ fontSize: '0.8rem' }}
                data-testid={`skill-decided-${row.name}`}
              >
                {row.name} · {statusLabel(row.status)}
                {row.status === 'rejected' && row.rejectReason
                  ? ` · ${t('skillProposals.reasonLine', { reason: row.rejectReason })}`
                  : ''}
                {row.status === 'revoked' && row.revokedAt
                  ? ` · ${t('skillProposals.revokedAt', { time: new Date(row.revokedAt).toLocaleString() })}`
                  : ''}
              </div>
            ))}
          </>
        ) : null}
        {msg ? <div className="muted" style={{ fontSize: '0.8rem' }}>{msg}</div> : null}
        {err ? <div style={{ color: 'var(--danger, #c44)', fontSize: '0.8rem' }}>{err}</div> : null}
      </div>
    </div>
  );
}
