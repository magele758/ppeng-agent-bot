import { MarkdownHtml } from './MarkdownHtml';

type SourceValue = string | number | boolean | null | SourceValue[] | { [key: string]: SourceValue };

function parseCollectedSource(body: string) {
  // The scheduler appends its input policy followed by the collector's JSON line.
  // Leave the prompt untouched when the collector provided ordinary text.
  const match = /^Input sources:[^\n]*\n((?:\{|\[)[^\n]*)/m.exec(body);
  if (!match) return null;
  const line = match[1];
  try {
    const end = match.index + match[0].length;
    return {
      before: body.slice(0, end - line.length),
      source: JSON.parse(line) as SourceValue,
      after: body.slice(end)
    };
  } catch {
    return null;
  }
}

function SourceField({ name, value }: { name: string; value: SourceValue }) {
  if (name === 'excerpt' && typeof value === 'string') return <MarkdownHtml text={value} />;
  return <div className="cron-source-field"><strong>{name}</strong>{' '}<SourceContent value={value} /></div>;
}

function SourceContent({ value }: { value: SourceValue }) {
  if (Array.isArray(value)) {
    return value.length ? value.map((item, i) => <div className="cron-source-item" key={i}><SourceContent value={item} /></div>) : '[]';
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value);
    return fields.length ? fields.map(([name, item]) => <SourceField key={name} name={name} value={item} />) : '{}';
  }
  return String(value);
}

export function CronPromptDocument({ body }: { body: string }) {
  const collected = parseCollectedSource(body);
  if (!collected) return <MarkdownHtml text={body} />;
  return <>
    <MarkdownHtml text={collected.before} />
    <SourceContent value={collected.source} />
    <MarkdownHtml text={collected.after} />
  </>;
}
