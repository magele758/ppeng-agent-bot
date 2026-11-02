/** Drop a non-empty line that is an exact copy of the line above it. */
export function collapseRepeatedLines(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const previous = kept.length > 0 ? kept[kept.length - 1] : undefined;
    if (line.trim() && previous === line) continue;
    kept.push(line);
  }
  return kept.join('\n');
}
