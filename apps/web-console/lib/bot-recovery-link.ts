export function botConnectionsHref(botId: string): string {
  return `#/agents/bots?bot=${encodeURIComponent(botId)}&focus=connections`;
}

export function readBotConnectionsTarget(hash: string): { botId: string } | null {
  const [path, query] = hash.split('?');
  if (path !== '#/agents/bots') return null;
  const params = new URLSearchParams(query);
  const botId = params.get('bot');
  return params.get('focus') === 'connections' && botId?.trim() ? { botId } : null;
}
