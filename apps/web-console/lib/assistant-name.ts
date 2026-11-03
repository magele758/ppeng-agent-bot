type Translate = (key: 'play.role.assistant' | 'play.role.streaming' | 'play.role.botStreaming', values?: { name: string }) => string;

export function assistantNameLabel(botName: string | null, streaming: boolean, t: Translate): string {
  const name = botName?.trim();
  if (!name) return t(streaming ? 'play.role.streaming' : 'play.role.assistant');
  return streaming ? t('play.role.botStreaming', { name }) : name;
}

export function transcriptBotName(botSurface: boolean, bot?: { name: string } | null): string | null {
  if (!botSurface) return null;
  return bot?.name ?? null;
}
