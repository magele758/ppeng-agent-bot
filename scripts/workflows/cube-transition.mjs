export function transition(prev,good,down,now){
 const state=good?'healthy':down?'down':'unknown',previous=prev.confirmed;
 const unknownSince=state==='unknown'?(prev.unknownSince??now.toISOString()):null;
 let notice='none';if(state==='down'&&previous!=='down')notice='fault';if(state==='healthy'&&previous==='down')notice='recovered';
 const longUnknown=unknownSince&&now-Date.parse(unknownSince)>=86400000;
 if(longUnknown&&!prev.unknownNotified)notice='unknown_24h';
 return {state,confirmed:state==='unknown'?previous:state,unknownSince,unknownNotified:Boolean(longUnknown),notice};
}
