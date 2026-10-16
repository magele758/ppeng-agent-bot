import {performance} from 'node:perf_hooks';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,Math.max(0,ms)));

/**
 * Fixed admission/completion window; a slow endpoint never creates an unbounded Promise chain.
 * Slots are admitted only before `deadline`. Work already started may finish within a bounded
 * `completionGraceMs` after it (default 0): without it the final planned slot, scheduled at
 * deadline-1/rate, would get a single inter-arrival gap (25ms at 40 rps) to complete.
 */
export async function runFixedHttpWindow({name,seconds,streams,onProgress,signal,completionGraceMs=0}) {
 if(!(seconds>0)||!streams.length||new Set(streams.map(s=>s.name)).size!==streams.length)throw new Error('A positive fixed window and streams are required');
 if(!(completionGraceMs>=0)||!Number.isFinite(completionGraceMs))throw new Error('Completion grace must be a finite non-negative duration');
 const start=performance.now(),wallStart=Date.now(),deadline=start+seconds*1000,completionDeadline=deadline+completionGraceMs,controller=new AbortController();let closed=false,admissionEnd;
 const state=streams.map(stream=>{
  const planned=seconds*stream.rate;if(!(stream.rate>0)||!Number.isFinite(stream.rate)||!Number.isInteger(planned)||stream.clients<1||!Number.isInteger(stream.clients)||!Number.isInteger(stream.maxPendingPerClient??1)||(stream.maxPendingPerClient??1)<0)throw new Error('Invalid rate, client count or queue bound');
  return {stream,next:0,clients:Array.from({length:stream.clients},()=>({active:false,started:false,pending:[]})),counts:{planned,offered:0,started:0,completed:0,failed:0,queueRejected:0,expiredQueued:0,timedOut:0,missedSchedule:0,maxActive:0,maxQueued:0},active:0,queued:0};
 });
 function begin(item,client,slot){
  if(closed||performance.now()>=deadline){item.counts.expiredQueued++;return;}
  client.active=true;client.started=false;item.active++;item.counts.maxActive=Math.max(item.counts.maxActive,item.active);
  Promise.resolve().then(()=>{
   if(closed)return {skipped:true};
   if(performance.now()>=deadline||controller.signal.aborted){client.active=false;item.active--;item.counts.expiredQueued++;return {skipped:true};}
   client.started=true;item.counts.started++;
   return Promise.resolve(item.stream.run({...slot,startedMono:performance.now(),deadlineMono:completionDeadline,signal:controller.signal})).then(value=>({ok:value!==false}));
  }).then(result=>{if(!result.skipped)settle(item,client,result.ok);},()=>settle(item,client,false));
 }
 function settle(item,client,ok){
  if(closed)return;
  if(performance.now()>=completionDeadline)return; // deadline finalization owns all still-active work
  item.counts[ok?'completed':'failed']++;client.active=false;item.active--;
  const next=client.pending.shift();if(next){item.queued--;begin(item,client,next);}
 }
 function offer(item){
  const index=item.next++,client=item.clients[index%item.clients.length];item.counts.offered++;
  const plannedMono=start+1000*index/item.stream.rate,slot={index,plannedMono,plannedWall:wallStart+plannedMono-start,enqueuedMono:performance.now()};
  if(!client.active){begin(item,client,slot);return;}
  if(client.pending.length>=(item.stream.maxPendingPerClient??1)){item.counts.queueRejected++;return;}
  client.pending.push(slot);item.queued++;item.counts.maxQueued=Math.max(item.counts.maxQueued,item.queued);
 }
 const abort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});
 let lastProgress=-Infinity;
 try{while(performance.now()<deadline&&!signal?.aborted){
  const now=performance.now();for(const item of state){while(item.next<item.counts.planned&&start+1000*item.next/item.stream.rate<=now&&performance.now()<deadline)offer(item);}
  if(onProgress&&now-lastProgress>=10000){lastProgress=now;onProgress({name,at:new Date().toISOString(),elapsedSeconds:(now-start)/1000,streams:Object.fromEntries(state.map(item=>[item.stream.name,{...item.counts,active:item.active,queued:item.queued}]))});}
  const next=Math.min(deadline,...state.map(item=>item.next<item.counts.planned?start+1000*item.next/item.stream.rate:deadline));await sleep(next-performance.now());
 }
 admissionEnd=performance.now();
 // Admission is closed; give already-started work its bounded completion grace.
 while(!signal?.aborted&&performance.now()<completionDeadline&&state.some(item=>item.active>0))await sleep(Math.min(5,completionDeadline-performance.now()));
 }finally{closed=true;signal?.removeEventListener('abort',abort);
 for(const item of state){item.counts.missedSchedule=item.counts.planned-item.next;item.counts.timedOut=item.clients.filter(client=>client.active&&client.started).length;item.counts.expiredQueued+=item.queued+item.clients.filter(client=>client.active&&!client.started).length;}
 controller.abort(new Error(`Fixed ${name} window expired`));}
 const results=Object.fromEntries(state.map(item=>[item.stream.name,{...item.counts,plannedRate:item.stream.rate,completedRate:item.counts.completed/seconds,clients:item.stream.clients,maxPendingPerClient:item.stream.maxPendingPerClient??1}]));
 const protocolPassed=!signal?.aborted&&Object.values(results).every(c=>c.completed===c.planned&&c.failed+c.queueRejected+c.expiredQueued+c.timedOut+c.missedSchedule===0);
 return {name,startedAt:new Date(wallStart).toISOString(),deadlineAt:new Date(wallStart+seconds*1000).toISOString(),finishedAt:new Date().toISOString(),windowSeconds:seconds,observedElapsedSeconds:(performance.now()-start)/1000,admissionElapsedSeconds:((admissionEnd??performance.now())-start)/1000,completionGraceMs,deadlineOvershootMs:Math.max(0,performance.now()-completionDeadline),streams:results,protocolPassed};
}
