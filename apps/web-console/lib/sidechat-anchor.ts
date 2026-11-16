import type { SidechatAnchor } from '@ppeng/api-types';

export function createQuoteAnchor(text: string, start: number, end: number): SidechatAnchor {
  return {
    kind: 'range',
    quote: text.slice(start, end),
    start,
    end,
    prefix: text.slice(Math.max(0, start - 48), start),
    suffix: text.slice(end, end + 48)
  };
}

function matchScore(text: string, index: number, anchor: SidechatAnchor) {
  const prefix = anchor.prefix || '';
  const suffix = anchor.suffix || '';
  let left = 0;
  let right = 0;
  while (left < prefix.length && text[index - left - 1] === prefix[prefix.length - left - 1]) left++;
  while (right < suffix.length && text[index + anchor.quote.length + right] === suffix[right]) right++;
  return left + right;
}

export function resolveQuoteAnchor(text: string, anchor: SidechatAnchor): [number, number] | null {
  if (anchor.kind !== 'range' || !anchor.quote) return null;
  const candidates: number[] = [];
  for (let at = text.indexOf(anchor.quote); at >= 0; at = text.indexOf(anchor.quote, at + 1)) candidates.push(at);
  if (!candidates.length) return null;
  const ranked = candidates
    .map((index) => ({ index, score: matchScore(text, index, anchor) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]!;
  if (ranked[1]?.score === best.score) {
    const original = ranked.find(
      (candidate) => candidate.index === anchor.start && candidate.score === best.score
    );
    const contextLength = (anchor.prefix || '').length + (anchor.suffix || '').length;
    if (!original || original.score !== contextLength || !contextLength) return null;
    return [original.index, original.index + anchor.quote.length];
  }
  return [best.index, best.index + anchor.quote.length];
}
