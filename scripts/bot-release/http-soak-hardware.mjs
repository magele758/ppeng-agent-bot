import {readFileSync} from 'node:fs';
import {cpus,totalmem,availableParallelism} from 'node:os';

/** Report measured host resources separately from provable cgroup limits. Missing limits are unknown. */
export function readSoakHardware({readText=path=>readFileSync(path,'utf8'),host={cpuLogicalCount:cpus().length,cpuAvailableParallelism:availableParallelism(),memoryBytes:totalmem()}}={}){
 const read=path=>{try{return String(readText(path)).trim();}catch{return null;}};
 const membership=read('/proc/self/cgroup')??'';
 const v2=membership.split('\n').find(line=>line.startsWith('0::'))?.slice(3)??'';
 const candidates=[...new Set([v2?'/sys/fs/cgroup'+v2:'', '/sys/fs/cgroup'].filter(Boolean))];
 let cgroup={version:null,source:null,cpuQuotaCores:null,memoryLimitBytes:null,verified:false},cpuMax=null,memoryMax=null;
 for(const base of candidates){const cpu=read(base+'/cpu.max');if(cpu===null)continue;const memory=read(base+'/memory.max');const [quota,period]=cpu.split(/\s+/);const numeric=Number(quota),periodNumber=Number(period);cpuMax=cpu;memoryMax=memory;cgroup={version:2,source:base,cpuQuotaCores:quota==='max'?null:numeric>0&&periodNumber>0?numeric/periodNumber:null,memoryLimitBytes:memory==='max'||memory===null?null:Number(memory)>0?Number(memory):null,verified:true};break;}
 if(!cgroup.verified){const controllers=membership.split('\n').map(line=>{const [id,names,...path]=line.split(':');return {names:names?.split(',')??[],path:path.join(':')};});const cpuPath=controllers.find(row=>row.names.includes('cpu'))?.path??'';const memoryPath=controllers.find(row=>row.names.includes('memory'))?.path??'';for(const root of ['/sys/fs/cgroup/cpu','/sys/fs/cgroup/cpu,cpuacct']){const bases=[...new Set([root+cpuPath,root])];for(const base of bases){const quota=read(base+'/cpu.cfs_quota_us'),period=read(base+'/cpu.cfs_period_us');if(quota===null||period===null)continue;cpuMax=quota+' '+period;const memoryBases=[...new Set(['/sys/fs/cgroup/memory'+memoryPath,'/sys/fs/cgroup/memory'])];memoryMax=memoryBases.map(base=>read(base+'/memory.limit_in_bytes')).find(value=>value!==null)??null;cgroup={version:1,source:base,cpuQuotaCores:Number(quota)>0&&Number(period)>0?Number(quota)/Number(period):null,memoryLimitBytes:Number(memoryMax)>0&&Number(memoryMax)<2**60?Number(memoryMax):null,verified:true};break;}if(cgroup.verified)break;}}
 return {host:{...host},cgroup,cpuMax,memoryMax,resourceLimitsStatus:cgroup.verified?'cgroup observed; dedicated reference hardware unverified':'cgroup unavailable; limits unknown',referenceHardwareMatched:false};
}
