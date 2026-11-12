// Segment Chinese as words so a common character alone cannot pull in a room transcript.
// Identifiers are split (oldCode, ALPHA_PRIVATE_CODE) so a question can name one piece.
const words = new Intl.Segmenter('zh', { granularity: 'word' });
const stop = new Set(('the this that what which how why where who can are was were does do did is of to on in for and with please about tell me ' +
  '这个 那个 什么 如何 怎么 为什么 是否 一下 有关 相关 请问 帮我 我们 你们 以及 一个 几个 这些 目前 关于').split(' '));
const sharedFactNoun = new Set(['fact', 'facts', 'info', 'information', 'context', 'background', '事实', '信息', '背景']);
const sharedFactModifier = new Set(['check', 'current', 'shared', 'show', 'list', 'read', 'see', 'look', 'verify', 'review', 'inspect', 'now', '查看', '检查', '当前', '共享']);
// Scope words name the layer, not the fact. "group code" must not select every group* key by itself.
const scopeWord = new Set(['group', 'room', 'global', 'shared', 'only']);

function addTerms(result: Set<string>, token: string): void {
  const pieces = token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9\u4e00-\u9fff]+/);
  for (const item of [token.toLowerCase(), ...pieces.map(part => part.toLowerCase())]) {
    if (item.length > 1 && !stop.has(item)) result.add(item);
  }
}

function terms(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of words.segment(text.normalize('NFKC'))) {
    if (word.isWordLike) addTerms(result, word.segment);
  }
  return result;
}

// Room turns wrap the user text in a member prompt. Selection uses that text, not the wrapper.
export function currentQuestion(query: string): string {
  for (const raw of query.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('Trigger: {')) continue;
    try {
      const parsed = JSON.parse(line.slice('Trigger: '.length)) as { text?: unknown };
      if (typeof parsed?.text === 'string' && parsed.text.trim()) return parsed.text.trim();
    } catch {
      return query;
    }
  }
  return query;
}

function contentTopics(query: string): string[] {
  return [...terms(currentQuestion(query))].filter(word => word.length > 1);
}

export function backgroundMatches(query: string): (text: string) => boolean {
  const topics = contentTopics(query);
  // Short topics may have just one keyword. Longer questions need corroborating terms.
  const required = Math.max(1, Math.ceil(topics.length / 4));
  return text => {
    const candidate = terms(text);
    return topics.filter(term => candidate.has(term)).length >= required;
  };
}

// "Check current shared facts" names the inventory, not one fact's wording.
export function asksForCurrentSharedFacts(query: string): boolean {
  const topics = contentTopics(query);
  if (!topics.some(term => sharedFactNoun.has(term))) return false;
  return topics.every(term => sharedFactNoun.has(term) || sharedFactModifier.has(term));
}

function keyNamedInQuestion(query: string, key: string): boolean {
  const topics = new Set(contentTopics(query));
  for (const term of terms(key)) {
    if (topics.has(term) && !scopeWord.has(term)) return true;
  }
  return false;
}

// Authorized entries only. Callers must already have dropped other rooms and old groups.
export function selectSharedEntries(visible: Record<string, string>, query?: string): Record<string, string> {
  if (query === undefined || asksForCurrentSharedFacts(query)) return visible;
  const matches = backgroundMatches(query);
  return Object.fromEntries(Object.entries(visible).filter(([key, value]) => keyNamedInQuestion(query, key) || matches(`${key} ${value}`)));
}

// A request for the general room recap has no topical keywords to match.
export function asksForRoomRecap(query: string): boolean {
  const question = currentQuestion(query).trim();
  return /^(?:请(?:问|总结)?\s*)?(?:群里|群聊|群内)(?:刚才|最近|今天)?(?:都)?(?:说了什么|聊了什么|有什么消息|有啥消息|消息摘要)[？?。!！\s]*$/u.test(question)
    || /^(?:what(?:'s| is) new in (?:the )?(?:group|room)|what did (?:the )?(?:room|group) (?:say|discuss)|summari[sz]e (?:the )?(?:room|group chat))[?.!\s]*$/i.test(question);
}
