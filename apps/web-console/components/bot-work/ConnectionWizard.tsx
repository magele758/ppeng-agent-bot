'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { api, json, useAction, Feedback, Result } from './shared';

export function ConnectionWizard({ botId, existingIds, ready, onSaved }: {
  botId: string; existingIds: string[]; ready: boolean; onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const action = useAction();
  const [kind, setKind] = useState('http');
  const [name, setName] = useState('');
  const [tool, setTool] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('GET');
  const [query, setQuery] = useState('');
  const [mcpTool, setMcpTool] = useState('');
  const [secret, setSecret] = useState('');
  const [specFile, setSpecFile] = useState<File | null>(null);
  const [readOnlyOnly, setReadOnlyOnly] = useState(true);
  const [unsupported, setUnsupported] = useState<unknown[]>([]);
  const [saved, setSaved] = useState(false);
  return <form data-testid="bot-connection-wizard" onSubmit={event => {
    event.preventDefault();
    if(action.busy || !ready)return;
    setSaved(false);
    void action.run(async () => {
      const connectorId = name.trim();
      if (existingIds.includes(connectorId)) throw new Error(t('botWork.connectionExists'));
      let importedSpec: unknown;
      if (kind === 'openapi') {
        if (!specFile || specFile.size > 1024 * 1024) throw new Error(t('botWork.openApiFileLimit'));
        importedSpec = JSON.parse(await specFile.text());
      }
      if (kind === 'http') {
        const address = new URL(url);
        if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password) throw new Error(t('botWork.connectionAddressInvalid'));
      }
      const parameters = query.split(',').map(value => value.trim()).filter(Boolean);
      const inputSchema = kind === 'http' && method === 'GET'
        ? { type: 'object', properties: Object.fromEntries(parameters.map(key => [key, { type: 'string' }])), additionalProperties: false }
        : { type: 'object', additionalProperties: true };
      let credRef: string | undefined;
      if (kind !== 'mcp' && secret) {
        const credential = `BOT_CONNECTION_${crypto.randomUUID().replaceAll('-', '_')}`;
        await api(`/api/secrets/${credential}`, json({ value: secret }, 'PUT'));
        credRef = `vault:${credential}`;
      }
      const base = `/api/bots/${encodeURIComponent(botId)}/connections`;
      if (kind === 'openapi') {
        const result = await api(`${base}/import`, json({
          connectorId, spec: importedSpec, readOnlyOnly, createOnly: true,
          ...(credRef ? { credRef } : {}),
        })) as { unsupported?: unknown[] };
        setUnsupported(result.unsupported ?? []);
      } else await api(`${base}/${encodeURIComponent(connectorId)}`, json({
        createOnly: true,
        ...(credRef ? { credRef } : {}),
        tools: [{
          name: tool.trim(), description: description.trim(), inputSchema,
          executor: kind === 'http'
            ? { kind: 'http', url, method, parameters: parameters.map(name => ({ name, in: 'query' })),
              ...(credRef ? { auth: { kind: 'bearer' } } : {}) }
            : { kind: 'mcp', toolName: mcpTool.trim(), readOnly: false },
        }],
      }, 'PUT'));
      setSecret('');setSaved(true);
      await onSaved();
    });
  }}>
    <h4>{t('botWork.guidedConnection')}</h4>
    <p>{t('botWork.guidedConnectionHint')}</p>
    <label>{t('botWork.connectionKind')}<select aria-label={t('botWork.connectionKind')} value={kind} onChange={event => setKind(event.target.value)}>
      <option value="http">{t('botWork.httpConnection')}</option>
      <option value="openapi">{t('botWork.openApiConnection')}</option>
      <option value="mcp">{t('botWork.mcpConnection')}</option>
    </select></label>
    <label>{t('botWork.connectionName')}<input required value={name} onChange={event => setName(event.target.value)} /></label>
    {kind !== 'openapi' && <>
      <label>{t('botWork.operationName')}<input required pattern="[a-zA-Z][a-zA-Z0-9_]{0,64}" value={tool} onChange={event => setTool(event.target.value)} /></label>
      <label>{t('botWork.taskCapability')}<input required value={description} onChange={event => setDescription(event.target.value)} /></label>
    </>}
    {kind === 'http' ? <>
      <label>{t('botWork.serviceAddress')}<input required type="url" value={url} onChange={event => setUrl(event.target.value)} /></label>
      <label>{t('botWork.operationScope')}<select aria-label={t('botWork.operationScope')} value={method} onChange={event => setMethod(event.target.value)}>
        <option value="GET">{t('botWork.readOnlyHttp')}</option>
        <option value="POST">{t('botWork.writeHttp')}</option>
      </select></label>
      <label>{t('botWork.queryFields')}<input value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>{t('botWork.accessKey')}<input type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} /></label>
    </> : kind === 'openapi' ? <>
      <label>{t('botWork.openApiFile')}<input required type="file" accept=".json,application/json" onChange={event => setSpecFile(event.target.files?.[0] ?? null)} /></label>
      <p>{t('botWork.openApiSupport')}</p>
      <label><input type="checkbox" checked={readOnlyOnly} onChange={event => setReadOnlyOnly(event.target.checked)} />{t('botWork.openApiReadOnly')}</label>
      <label>{t('botWork.accessKey')}<input type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} /></label>
    </> : <>
      <label>{t('botWork.mcpToolName')}<input required value={mcpTool} onChange={event => setMcpTool(event.target.value)} /></label>
      <p>{t('botWork.mcpNeedsInvocation')}</p>
    </>}
    <Feedback {...action} />
    {unsupported.length > 0 && <><p>{t('botWork.openApiUnsupported')}</p><Result value={unsupported} /></>}
    {saved && <p role="status">{t('botWork.connectionConfigured')}</p>}
    <button disabled={action.busy || !ready}>{t('botWork.saveConnection')}</button>
  </form>;
}
