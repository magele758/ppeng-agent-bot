/** Prepend an older page. Ids already loaded keep the loaded copy, so a cursor overlap cannot duplicate a row. */
export function prependHistoryPage<T extends { id: string }>(loaded: T[], older: T[]): T[] {
  const loadedIds = new Set(loaded.map((message) => message.id));
  const head: T[] = [];
  const seen = new Set<string>();
  for (const message of older) {
    if (loadedIds.has(message.id) || seen.has(message.id)) continue;
    seen.add(message.id);
    head.push(message);
  }
  return [...head, ...loaded];
}

export function mergeHistoryWindow<T extends {id:string;seq?:number}>(previous:T[],incoming:T[],sameSession:boolean):{messages:T[];reset:boolean} {
 if(!sameSession||!previous.length)return {messages:incoming,reset:true};
 const ids=new Set(previous.map(message=>message.id));
 const overlap=incoming.some(message=>ids.has(message.id));
 const maxPrevious=previous.at(-1)?.seq;const minIncoming=incoming[0]?.seq;
 // A disjoint refresh must retain the new cursor, otherwise intermediate pages become unreachable.
 if(!overlap&&incoming.length&&!(maxPrevious!=null&&minIncoming!=null&&minIncoming<=maxPrevious+1))return {messages:incoming,reset:true};
 return {messages:Array.from(new Map([...previous,...incoming].map(message=>[message.id,message])).values()),reset:false};
}
