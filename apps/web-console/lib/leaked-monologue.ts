/** Drop a long non-Chinese paragraph when the same reply already has Chinese prose. */
function keepParagraph(part: string): boolean {
  if (/[\u4e00-\u9fff]/.test(part)) return true;
  const letters = part.match(/[A-Za-z]/g)?.length ?? 0;
  return letters < 12;
}

/**
 * Simplified view: hide `<think>` blocks and an English monologue that follows
 * a Chinese answer. An all-English reply is left intact.
 */
export function stripLeakedMonologue(text: string): string {
  const without = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const parts = without.split(/\n{2,}/);
  const hasCjk = parts.some((part) => /[\u4e00-\u9fff]/.test(part));
  if (!hasCjk) return without;
  return parts.filter((part) => keepParagraph(part)).join('\n\n').trim();
}
