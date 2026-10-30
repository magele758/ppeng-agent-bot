'use client';

import { useState } from 'react';
import { postConnectorGrant } from './ConnectorsSettingsCard';
import { connectorGrantApprovalCard, connectorGrantResultCard, type ConnectorGrantCardFace } from '@/lib/connectors-grant-card';
import { useI18n } from '@/lib/i18n';

function GrantNameField({
  face,
  name,
  busy,
  onName
}: {
  face: ConnectorGrantCardFace;
  name: string;
  busy: boolean;
  onName: (name: string) => void;
}) {
  const { t } = useI18n();
  if (face.authState !== 'needsAuth') return null;
  return (
    <input
      className="connector-grant-card__name"
      aria-label={t('play.approval.connectorGrantVault')}
      autoComplete="off"
      spellCheck={false}
      disabled={busy}
      value={name}
      onChange={(event) => onName(event.target.value)}
    />
  );
}

function grantStatusText(failed: boolean, failedText: string, doneText: string): string {
  return failed ? failedText : doneText;
}

export function ConnectorGrantFace({ face }: { face: ConnectorGrantCardFace }) {
  const { t } = useI18n();
  const [name, setName] = useState(face.secretEnv ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const blocked = busy || (face.authState === 'needsAuth' && !name.trim());
  const grant = () => {
    if (blocked) return;
    setBusy(true);
    void postConnectorGrant(face.row, name)
      .then(() => setStatus(grantStatusText(false, t('play.approval.connectorGrantFailed'), t('play.approval.connectorGrantDone'))))
      .catch(() => setStatus(grantStatusText(true, t('play.approval.connectorGrantFailed'), t('play.approval.connectorGrantDone'))))
      .finally(() => setBusy(false));
  };
  if (status) return <p className="connector-grant-card__status">{status}</p>;
  return (
    <div className="connector-grant-card" data-connector-id={face.id} data-auth-state={face.authState}>
      <p>{t('play.approval.connectorGrantPrompt', { title: face.title })}</p>
      <GrantNameField face={face} name={name} busy={busy} onName={setName} />
      <button type="button" data-grant={face.id} disabled={blocked} onClick={grant}>
        {t('play.approval.connectorGrant')}
      </button>
    </div>
  );
}

/** Tool-result mount. Model view and a missing card stay empty. */
export function ConnectorGrantFill({ content, modelView }: { content: string; modelView?: boolean }) {
  if (modelView) return null;
  const face = connectorGrantResultCard(content);
  if (!face) return null;
  return <ConnectorGrantFace face={face} />;
}

/** Approval-banner mount. Other tools stay empty. */
export function ConnectorGrantApproval({ toolName, args }: { toolName: string; args?: Record<string, unknown> }) {
  const face = connectorGrantApprovalCard({ toolName, args });
  if (!face) return null;
  return <ConnectorGrantFace face={face} />;
}
