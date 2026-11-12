// Segment Chinese as words so a common character alone cannot pull in a room transcript.
const words = new Intl.Segmenter('zh', { granularity: 'word' });
const stop = new Set(('the this that what which how why where who can are was were does do did is of to on in for and with please about tell me ' +
  '这个 那个 什么 如何 怎么 为什么 是否 一下 有关 相关 请问 帮我 我们 你们 以及 一个 几个 这些 目前 关于').split(' '));

function terms(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of words.segment(text.normalize('NFKC').toLowerCase())) {
    if (word.isWordLike && !stop.has(word.segment)) result.add(word.segment);
  }
  return result;
}

export function backgroundMatches(query: string): (text: string) => boolean {
  const topics = [...terms(query)].filter(word => word.length > 1);
  // Short topics may have just one keyword. Longer questions need corroborating terms.
  const required = Math.max(1, Math.ceil(topics.length / 4));
  return text => {
    const candidate = terms(text);
    return topics.filter(term => candidate.has(term)).length >= required;
  };
}

// A request for the general room recap has no topical keywords to match.
export function asksForRoomRecap(query: string): boolean {
  return /^(?:请(?:问|总结)?\s*)?(?:群里|群聊|群内)(?:刚才|最近|今天)?(?:都)?(?:说了什么|聊了什么|有什么消息|有啥消息|消息摘要)[？?。!！\s]*$/u.test(query.trim())
    || /^(?:what(?:'s| is) new in (?:the )?(?:group|room)|what did (?:the )?(?:room|group) (?:say|discuss)|summari[sz]e (?:the )?(?:room|group chat))[?.!\s]*$/i.test(query.trim());
}
