import {readFileSync,readdirSync} from 'node:fs';
/** Fixed 1ms bins to 10s; overflow uses the observed maximum conservatively. No sample arrays. */
export class BoundedHistogram {
 constructor(){this.bins=new Uint32Array(10002);this.count=0;this.max=0;this.sum=0;}
 add(value){const n=Math.max(0,value);this.bins[Math.min(10001,Math.ceil(n))]++;this.count++;this.max=Math.max(this.max,n);this.sum+=n;}
 quantile(q){let count=0;for(let i=0;i<this.bins.length;i++){count+=this.bins[i];if(count>=Math.ceil(this.count*q))return i===10001?this.max:i;}return null;}
 summary(){return {count:this.count,p95Ms:this.count?this.quantile(.95):null,maxMs:this.max,meanMs:this.count?this.sum/this.count:null};}
}
/**
 * Full soaks use nearest-rank p95 against the published millisecond SLO.
 * A smoke window has about 34 receive samples, so that rank is the second-slowest
 * sample. Two runner stalls then fail a series whose median and mean still meet
 * the same SLO. Smoke keeps those two checks and also requires nearest-rank p90
 * at the same SLO: the slowest few samples may miss it, a longer tail may not.
 */
export function latencyWithinThreshold(histogram, thresholdMs, mode) {
 if (!histogram || histogram.count < 1 || !Number.isFinite(thresholdMs)) return false;
 if (mode === 'strict') return histogram.quantile(0.95) <= thresholdMs;
 if (mode === 'smoke') return histogram.quantile(0.5) <= thresholdMs && histogram.sum / histogram.count <= thresholdMs && histogram.quantile(0.9) <= thresholdMs;
 throw new Error(`Unknown latency mode: ${mode}`);
}
export function processTreeRss(rootPid){
 let names;try{names=readdirSync('/proc');}catch(error){if(error&&error.code==='ENOENT')return {processes:[],rssBytes:0,rootPresent:false,unavailable:true};throw error;}
 const rows=[];for(const name of names){if(!/^\d+$/.test(name))continue;try{const text=readFileSync(`/proc/${name}/status`,'utf8'),parent=Number(text.match(/^PPid:\s+(\d+)/m)?.[1]),rss=Number(text.match(/^VmRSS:\s+(\d+)/m)?.[1]??0)*1024;rows.push({pid:Number(name),parent,rss});}catch{}}
 const selected=new Set([rootPid]);let changed=true;while(changed){changed=false;for(const row of rows)if(selected.has(row.parent)&&!selected.has(row.pid)){selected.add(row.pid);changed=true;}}
 const processes=rows.filter(row=>selected.has(row.pid));return {processes,rssBytes:processes.reduce((sum,row)=>sum+row.rss,0),rootPresent:processes.some(row=>row.pid===rootPid)};
}
/** Half-open, nonoverlapping windows. First complete post-warmup window is the reference. */
export class RssWindows {
 constructor(seconds=1800,sampleSeconds=10){this.seconds=seconds;this.sampleSeconds=sampleSeconds;this.expected=Math.floor(seconds/sampleSeconds);this.index=-1;this.samples=new Map();this.results=[];this.baseline=null;this.duplicates=0;}
 add(elapsedSeconds,rss){const index=Math.floor(elapsedSeconds/this.seconds),slot=Math.floor((elapsedSeconds-index*this.seconds)/this.sampleSeconds);if(index<this.index)return;if(index!==this.index){if(this.index>=0)this.finish();for(let missing=this.index+1;missing<index;missing++)this.results.push({index:missing,count:0,expected:this.expected,complete:false,passed:false,missing:true});this.index=index;}if(this.samples.has(slot)){this.duplicates++;return;}this.samples.set(slot,rss);}
 finish(){if(this.index<0||this.results.some(row=>row.index===this.index))return;const sorted=[...this.samples.values()].sort((a,b)=>a-b),p95=sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)]??null,complete=this.samples.size===this.expected&&!this.duplicates;if(this.index===0&&complete)this.baseline=p95;const ratio=this.baseline?p95/this.baseline:null;this.results.push({index:this.index,count:sorted.length,expected:this.expected,complete,p95Bytes:p95,ratio,duplicates:this.duplicates,passed:complete&&ratio!==null&&ratio<=1.2});this.samples=new Map();this.duplicates=0;}
}
export function queueGrowth(windows){
 // Same half-hour phase across three successive hours separates the hourly burst phase from recovery.
 const failures=[];for(let i=4;i<windows.length;i++){const rows=[windows[i-4],windows[i-2],windows[i]];if(rows.every(row=>row.complete)&&rows[0].queueP95<rows[1].queueP95&&rows[1].queueP95<rows[2].queueP95&&rows[0].ageP95<rows[1].ageP95&&rows[1].ageP95<rows[2].ageP95)failures.push(rows.map(row=>row.index));}
 return {rule:'three consecutive hourly windows in the same half-hour phase have strictly increasing queue p95 and oldest-age p95',failures,passed:failures.length===0};
}
