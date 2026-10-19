/** IPC supervisor; synchronous observation cuts pause only scheduling, never alter decisions/state. */
import {spawn} from 'node:child_process';
import{writeFileSync}from'node:fs';
import{join,dirname}from'node:path';
import{fileURLToPath}from'node:url';
import{sanitizeScriptEnv}from'../spawn-utils.mjs';
const ROOT=join(dirname(fileURLToPath(import.meta.url)),'../..');
const live=new Set();
process.on('SIGTERM',()=>{for(const p of live)p.kill('SIGKILL');process.exit(2);});
export async function service(config,{mutation,childExecutable=process.execPath}={}){
  const args=['--import',join(ROOT,'scripts/formal/concurrency-register.mjs'),join(ROOT,'scripts/formal/concurrency-child.mjs'),JSON.stringify(config)];if(mutation)args.push('--mutation',mutation);
  const p=spawn(childExecutable,args,{cwd:ROOT,env:sanitizeScriptEnv({PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP}),stdio:['ignore','ignore','pipe','ipc']});live.add(p);
  let seq=0,stderr='',exited=false,readyResolve,readyReject;const pending=new Map(),observations=[],waiters=[];
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const exit=new Promise(resolve=>{const finish=(code,signal)=>{if(exited)return;exited=true;live.delete(p);const error=new Error('Process exited: '+stderr.slice(-1000));readyReject(error);for(const c of pending.values()){clearTimeout(c.timer);c.reject(error);}pending.clear();for(const w of waiters){clearTimeout(w.timer);w.reject(error);}resolve({code,signal});};p.once('exit',finish);p.once('close',finish);p.once('error',error=>{readyReject(error);finish(null,'spawn-error');});});
  p.stderr.on('data',d=>stderr=(stderr+d).slice(-30000));
  p.on('message',m=>{if(m.ready)return readyResolve(m);if(m.cut){observations.push(m);for(const w of [...waiters])if(w.name===m.cut){waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(m);break;}return;}const c=pending.get(m.id);if(c){pending.delete(m.id);clearTimeout(c.timer);if(m.error)c.reject(new Error(m.error));else c.resolve(m.value);}});
  const timer=setTimeout(()=>readyReject(new Error('Readiness timeout: '+stderr.slice(-1000))),12000);
  try{await ready;}catch(e){p.kill('SIGKILL');await exit;throw e;}finally{clearTimeout(timer);}
  const consumed=new Set();
  return {pid:p.pid,name:config.process,
    rpc(command,args){if(exited)return Promise.reject(new Error('Process already exited'));return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout: '+command+' '+stderr.slice(-1000)));},18000);pending.set(id,{resolve,reject,timer});p.send({id,command,args},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});});},
    async cut(name,timeoutMs=10000){let found=observations.find(c=>c.cut===name&&!consumed.has(c.token));if(!found)found=await new Promise((resolve,reject)=>{const w={name,resolve,reject,timer:setTimeout(()=>reject(new Error('Missing phase barrier: '+name)),timeoutMs)};waiters.push(w);});consumed.add(found.token);return found;},
    proceed(cut){writeFileSync(join(config.dir,cut.token),'continue');},
    async stop(){if(!exited)p.kill('SIGKILL');return exit;},get alive(){return !exited;},get mutationLoaded(){return !!mutation&&stderr.includes('CONCURRENCY_MUTATION_LOADED:'+mutation);}
  };
}
