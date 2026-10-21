import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { parseEnvContent } from './env-utils';
import { withRawFiles, type UpdateJournal } from './update-transaction';
export interface Release { protocol: number; version: string; buildId: string; notes: string; platform: string; arch: string }
export function sanitizeSpawnEnv(extra:NodeJS.ProcessEnv={}):Record<string,string> {
 const env:Record<string,string>={};
 for(const k of ['HOME','PATH','TMPDIR','LANG'])if(process.env[k])env[k]=process.env[k]!;
 for(const [k,v] of Object.entries(extra))if(typeof v==='string'&&!/^(LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|PYTHON|JAVA_TOOL_OPTIONS$|_JAVA_OPTIONS$|RUBY|PERL|BASH|ENV$|IFS$|CDPATH$|SHELLOPTS$|PROMPT_COMMAND$)/.test(k))env[k]=v;
 return env;
}
export function command(bin:string,args:string[]):string {return execFileSync(bin,args,{env:sanitizeSpawnEnv(),encoding:'utf8',timeout:120_000,maxBuffer:1024*1024});}
export function readRelease(app:string):Release {
 const r=JSON.parse(fs.readFileSync(path.join(app,'Contents/Resources/desktop-update.json'),'utf8')) as Release;
 if(r.protocol!==1||r.platform!=='darwin'||r.arch!=='arm64'||!r.version||!r.buildId||typeof r.notes!=='string')throw Error('Invalid or incompatible update package');
 return r;
}
export function executable(app:string){return path.join(app,'Contents/MacOS/Raw Agent');}
export function validateApp(app:string):Release {
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Only macOS Apple Silicon is supported');
 const r=readRelease(app);
 const id=command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',path.join(app,'Contents/Info.plist')]).trim();
 if(id!=='dev.ppeng.agent')throw Error('Wrong application bundle');
 command('/usr/bin/codesign',['--verify','--deep','--strict',app]);
 if(!command('/usr/bin/lipo',['-archs',executable(app)]).includes('arm64'))throw Error('Wrong CPU architecture');
 for(const p of ['Contents/Resources/server-bundle/apps/daemon/dist/server.js','Contents/Resources/web/apps/web-console/server.js'])if(!fs.existsSync(path.join(app,p)))throw Error('Incomplete application bundle');
 return r;
}
export function treeBytes(p:string):number {return withRawFiles(()=>{const s=fs.lstatSync(p);if(s.isSymbolicLink())return 0;return s.isDirectory()?fs.readdirSync(p).reduce((n,f)=>n+treeBytes(path.join(p,f)),0):s.size;});}
export async function preflight(j:UpdateJournal):Promise<void>{
 const release=validateApp(j.candidate);
 if(j.targetVersion!==release.version+' '+release.buildId)throw Error('Selected release changed since confirmation');
 for(const p of [path.dirname(j.app),j.data,j.root])fs.accessSync(p,fs.constants.R_OK|fs.constants.W_OK);
 const appBytes=treeBytes(j.app),dataBytes=treeBytes(j.data),newBytes=treeBytes(j.candidate);
 // Keep room for backup, staged install, and another full recovery staging copy.
 for(const [p,needed] of [[j.root,2*(appBytes+dataBytes)+newBytes],[path.dirname(j.app),2*appBytes+newBytes],[path.dirname(j.data),2*dataBytes]] as const){const stat=fs.statfsSync(p);if(stat.bavail*stat.bsize<needed+256*1024*1024)throw Error('Insufficient free space for backup and rollback');}
}
export function alive(pid:number):boolean {try{process.kill(pid,0);return true;}catch{return false;}}
export async function waitExit(pid:number,timeout=30_000):Promise<void>{const end=Date.now()+timeout;while(alive(pid)){if(Date.now()>end)throw Error('Process did not exit; update stopped');await new Promise(r=>setTimeout(r,100));}}
export async function stopChild(child:ChildProcess):Promise<void>{
 if(child.exitCode!==null||child.signalCode!==null)return;
 const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGTERM');
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Child shutdown timeout')),20_000);})]);}finally{if(timer)clearTimeout(timer);}
}
async function freePort():Promise<number>{return new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=(s.address() as {port:number}).port;s.close(()=>resolve(p));});});}
export interface ValidationProcess { pid: number; identity: string }
function processIdentity(pid:number):string {return command('/bin/ps',['-p',String(pid),'-o','lstart=','-o','command=']).trim();}
export function captureProcesses(pids:number[]):ValidationProcess[] {
 return [...new Set(pids)].flatMap(pid=>{try{return [{pid,identity:processIdentity(pid)}];}catch{return [];}});
}
export function isRecordedProcessAlive(row:ValidationProcess):boolean {
 if(!alive(row.pid))return false;try{return processIdentity(row.pid)===row.identity;}catch{return false;}
}
export async function waitRecordedProcesses(rows:ValidationProcess[]):Promise<void>{
 for(const row of rows){if(!alive(row.pid))continue;let identity:string;try{identity=processIdentity(row.pid);}catch{continue;}if(identity===row.identity)await waitExit(row.pid,60_000);}
}
function recordValidationProcess(j:UpdateJournal,c:ChildProcess):void {
 if(!c.pid)return;
 const file=path.join(j.backup,'validation-processes.json');
 const rows:ValidationProcess[]=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
 let identity:string;try{identity=processIdentity(c.pid);}catch{return;}
 rows.push({pid:c.pid,identity});
 const fd=fs.openSync(file+'.new','w',0o600);try{fs.writeFileSync(fd,JSON.stringify(rows));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(file+'.new',file);
}
export async function stopOrphanedValidation(j:UpdateJournal):Promise<void>{
 const file=path.join(j.backup,'validation-processes.json');if(!fs.existsSync(file))return;
 for(const row of JSON.parse(fs.readFileSync(file,'utf8')) as ValidationProcess[]){
  if(!alive(row.pid))continue;
  let identity:string;try{identity=processIdentity(row.pid);}catch{continue;}
  if(identity!==row.identity)continue;
  process.kill(row.pid,'SIGTERM');
  try{await waitExit(row.pid,20_000);}catch{process.kill(row.pid,'SIGKILL');await waitExit(row.pid,10_000);}
 }
}
export async function validateStaged(j:UpdateJournal):Promise<void>{
 const release=validateApp(j.stagedApp);
 if(j.targetVersion!==release.version+' '+release.buildId)throw Error('Staged release differs from confirmed release');
}
export async function verifyInstalled(j:UpdateJournal):Promise<void>{
 validateApp(j.app);
 const dp=await freePort(),wp=await freePort(),res=path.join(j.app,'Contents/Resources');
 const envFile=path.join(j.data,'.env');const settings=fs.existsSync(envFile)?parseEnvContent(fs.readFileSync(envFile,'utf8')):{};
 const env=sanitizeSpawnEnv({...settings,ELECTRON_RUN_AS_NODE:'1',NODE_ENV:'production',RAW_AGENT_STATE_DIR:path.join(j.data,'state'),RAW_AGENT_DAEMON_HOST:'127.0.0.1',RAW_AGENT_DAEMON_PORT:String(dp),PORT:String(wp),HOSTNAME:'127.0.0.1',DAEMON_PROXY_TARGET:`http://127.0.0.1:${dp}`});
 const children:ChildProcess[]=[];
 const log=fs.openSync(path.join(j.backup,'validation.log'),'a',0o600);
 try {
  const d=spawn(executable(j.app),[path.join(res,'server-bundle/apps/daemon/dist/server.js'),'--desktop-update-validation'],{cwd:path.join(res,'server-bundle'),env,stdio:['ignore',log,log]});children.push(d);recordValidationProcess(j,d);
  let spawnError:Error|undefined;d.once('error',e=>{spawnError=e;});
  async function ready(url:string,c:ChildProcess,validation=false){for(let n=0;n<150;n++){if(spawnError)throw spawnError;if(c.exitCode!==null)throw Error('New service exited; see validation.log');try{const r=await fetch(url,{signal:AbortSignal.timeout(1000)});if(r.ok){if(validation&&!(await r.json() as {desktopUpdateValidation?:boolean}).desktopUpdateValidation)throw Error('Missing update validation barrier');return;}}catch(e){if(String(e).includes('barrier'))throw e;}await new Promise(r=>setTimeout(r,200));}throw Error('New version startup timed out');}
  await ready(`http://127.0.0.1:${dp}/api/health`,d,true);
  if((await fetch(`http://127.0.0.1:${dp}/api/sessions`,{signal:AbortSignal.timeout(2000)})).status!==503)throw Error('Validation did not block task requests');
  const w=spawn(executable(j.app),[path.join(res,'web/apps/web-console/server.js')],{cwd:path.join(res,'web'),env,stdio:['ignore',log,log]});children.push(w);recordValidationProcess(j,w);w.once('error',e=>{spawnError=e;});
  await ready(`http://127.0.0.1:${wp}/`,w);
 }finally{
  // Never restore a database while a validation child could still be writing it.
  for(const child of children){try{await stopChild(child);}catch{child.kill('SIGKILL');if(child.pid){try{await waitExit(child.pid);}catch{throw Object.assign(Error('Validation process is still alive; stop it before recovery'),{unsafeToRestore:true});}}}}
  fs.closeSync(log);
 }
 // Run with the bundled runtime, independent of the user's terminal Node version.
 const check=path.join(res,'app.asar/dist/update-data-check.js');
 execFileSync(executable(j.app),[check,path.join(j.data,'state'),path.join(j.backup,'data/state')],{env:sanitizeSpawnEnv({ELECTRON_RUN_AS_NODE:'1'}),timeout:30_000,stdio:'pipe'});
}
