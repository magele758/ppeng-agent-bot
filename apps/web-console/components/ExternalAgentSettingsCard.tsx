'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { SettingsGroup } from './ui';
import { LoadGate, SaveBar, StatusLine, TextField, ToggleField } from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';

interface Client {
  id: string;
  name: string;
  enabled: boolean;
  allowedAgentIds: string[];
  defaultAgentId: string;
  tokenSet: boolean;
}
interface Settings { enabled: boolean; clients: Client[] }
interface DraftClient extends Omit<Client, 'allowedAgentIds'> { allowedAgentIds: string; token: string; rowKey: string }
const PATH = '/api/external-agents/settings';
const toDraft = (client: Client): DraftClient => ({ ...client, allowedAgentIds: client.allowedAgentIds.join(', '), token: '', rowKey: client.id });
const toPayload = ({ allowedAgentIds, token, rowKey: _rowKey, tokenSet: _tokenSet, ...client }: DraftClient) => ({
  ...client, allowedAgentIds: allowedAgentIds.split(/[,\s]+/).filter(Boolean), ...(token.trim() ? { token: token.trim() } : {})
});

function ExecutorsHint({ agentIds }: { agentIds: string[] }) {
  const { t } = useI18n();
  if (!agentIds.length) return null;
  return <p className="muted small">{t('externalAgents.executors', { ids: agentIds.join(', ') })}</p>;
}

export function ExternalAgentSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<Settings>(PATH);
  const [enabled, setEnabled] = useState(false);
  const [clients, setClients] = useState<DraftClient[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const reset = () => {
    if (!r.settings) return;
    setEnabled(r.settings.enabled);
    setClients(r.settings.clients.map(toDraft));
  };
  useEffect(() => {
    if (!r.settings) return;
    setEnabled(r.settings.enabled);
    setClients(r.settings.clients.map(toDraft));
  }, [r.settings]);
  useEffect(() => {
    let live = true;
    void api('/api/agents').then(data => {
      if (live) setAgentIds((data as { agents: { id: string }[] }).agents.map(agent => agent.id));
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  const payload = { enabled, clients: clients.map(toPayload) };
  const saved = r.settings ? { enabled: r.settings.enabled, clients: r.settings.clients.map(c => toPayload(toDraft(c))) } : null;
  const dirty = saved !== null && JSON.stringify(payload) !== JSON.stringify(saved);
  const edit = (rowKey: string, patch: Partial<DraftClient>) => setClients(values => values.map(c => c.rowKey === rowKey ? { ...c, ...patch } : c));
  const save = async () => {
    const result = await r.run(async () => {
      await api(PATH, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      await r.reload();
      return true;
    }, () => t('settingsEntries.common.saved'));
    if (result) setClients(values => values.map(c => ({ ...c, token: '' })));
  };

  return (
    <SettingsGroup id="card-externalAgents" title={t('externalAgents.title')} description={t('externalAgents.description')}>
      <LoadGate ready={r.settings !== null} error={r.loadError} onRetry={() => void r.reload()}>
        {r.settings ? <>
          <ToggleField id="external-agents-enabled" label={t('externalAgents.enabled')} hint={t('externalAgents.enabledHint')}
            checked={enabled} disabled={r.busy} onChange={setEnabled} />
          <p className="muted small">{t('externalAgents.endpoint', { path: '/api/external-agent/v1/tasks' })}</p>
          <ExecutorsHint agentIds={agentIds} />
          {clients.map((client, index) => {
            const field = `external-agent-${index}`;
            return <fieldset key={client.rowKey} data-external-agent-client disabled={r.busy}>
              <legend>{client.name || t('externalAgents.newClient')}</legend>
              <TextField id={`${field}-id`} label={t('externalAgents.clientId')} hint={t('externalAgents.clientIdHint')}
                value={client.id} disabled={r.busy || client.tokenSet} onChange={id => edit(client.rowKey, { id })} />
              <TextField id={`${field}-name`} label={t('externalAgents.name')} value={client.name}
                disabled={r.busy} onChange={name => edit(client.rowKey, { name })} />
              <ToggleField id={`${field}-enabled`} label={t('externalAgents.clientEnabled')} checked={client.enabled}
                disabled={r.busy} onChange={enabled => edit(client.rowKey, { enabled })} />
              <TextField id={`${field}-token`} type="password" label={t('externalAgents.token')} hint={t('externalAgents.tokenHint')}
                placeholder={client.tokenSet ? t('settingsEntries.common.keepSecret') : ''} value={client.token}
                disabled={r.busy} onChange={token => edit(client.rowKey, { token })} />
              <TextField id={`${field}-allowed`} label={t('externalAgents.allowedAgents')} hint={t('externalAgents.allowedAgentsHint')}
                value={client.allowedAgentIds} disabled={r.busy} onChange={allowedAgentIds => edit(client.rowKey, { allowedAgentIds })} />
              <TextField id={`${field}-default`} label={t('externalAgents.defaultAgent')} hint={t('externalAgents.defaultAgentHint')}
                value={client.defaultAgentId} disabled={r.busy} onChange={defaultAgentId => edit(client.rowKey, { defaultAgentId })} />
              <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy}
                onClick={() => setClients(values => values.filter(c => c.rowKey !== client.rowKey))}>{t('externalAgents.remove')}</button>
            </fieldset>;
          })}
          {clients.length === 0 ? <p className="muted">{t('externalAgents.empty')}</p> : null}
          <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy} onClick={() => setClients(values => [...values, {
            rowKey: `new-${Date.now()}-${Math.random()}`, id: '', name: '', enabled: true, token: '', tokenSet: false,
            allowedAgentIds: 'general', defaultAgentId: 'general'
          }])}>{t('externalAgents.add')}</button>
          <SaveBar dirty={dirty} busy={r.busy} onSave={() => void save()} onReset={reset} />
        </> : null}
        <StatusLine status={r.status} />
      </LoadGate>
    </SettingsGroup>
  );
}
