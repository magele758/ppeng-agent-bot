import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
export interface UpdateInput { root: string; app: string; candidate: string; data: string; currentVersion: string; targetVersion: string; notes: string }
export type Phase = 'prepared'|'backing-up'|'backed-up'|'installing'|'verifying'|'complete'|'rolling-back'|'rolled-back'|'failed'|'recovery-required';
export interface UpdateJournal extends UpdateInput { id: string; phase: Phase; backup: string; stagedApp: string; displacedApp: string; error?: string }
export interface UpdateOperations { preflight: (j: UpdateJournal)=>Promise<void>; stop: (j: UpdateJournal)=>Promise<void>; verify: (j: UpdateJournal)=>Promise<void>; validateStage?: (j: UpdateJournal)=>Promise<void> }
export const terminalPhase = (p: Phase) => ['complete','rolled-back','failed'].includes(p);
export function describeUpdate(i: UpdateInput) { return {currentVersion:i.currentVersion,targetVersion:i.targetVersion,notes:i.notes}; }
export function readUpdate(root: string): UpdateJournal | undefined {
 const p=path.join(root,'transaction.json');return fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):undefined;
}
export function writeUpdate(j: UpdateJournal): void {
 const p=path.join(j.root,'transaction.json'),tmp=p+'.new';
 const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(j,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,p);
 if(terminalPhase(j.phase)&&fs.existsSync(path.join(j.root,'active.lock')))fs.unlinkSync(path.join(j.root,'active.lock'));
 const dir=fs.openSync(j.root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function contained(a:string,b:string) {const rel=path.relative(a,b);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
function validatePaths(i: UpdateInput) {
 const paths=[i.root,i.app,i.candidate,i.data].map(p=>path.resolve(p));
 for(let a=0;a<paths.length;a++)for(let b=a+1;b<paths.length;b++)if(contained(paths[a],paths[b])||contained(paths[b],paths[a]))throw Error('Update paths must be separate');
}
export async function beginUpdate(i: UpdateInput, idle:()=>Promise<boolean>):Promise<UpdateJournal> {
 validatePaths(i);fs.mkdirSync(i.root,{recursive:true,mode:0o700});
 const lock=path.join(i.root,'active.lock');const old=readUpdate(i.root);
 if(old&&!terminalPhase(old.phase))throw Error('Update already in progress');

 let fd:number;try{fd=fs.openSync(lock,'wx',0o600);}catch{throw Error('Update already in progress');}fs.closeSync(fd);
 try {
  if(!await idle())throw Error('Client busy; wait for running tasks to finish');
  const id=randomUUID();const j:UpdateJournal={...i,id,phase:'prepared',backup:path.join(i.root,id),stagedApp:i.app+'.update-'+id,displacedApp:i.app+'.previous-'+id};
  fs.mkdirSync(j.backup,{mode:0o700});writeUpdate(j);return j;
 }catch(e){fs.unlinkSync(lock);throw e;}
}
function syncTree(p:string):void {const s=fs.lstatSync(p);if(s.isSymbolicLink())return;if(s.isDirectory()){for(const n of fs.readdirSync(p))syncTree(path.join(p,n));}const fd=fs.openSync(p,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function withRawFiles<T>(operation:()=>T):T {
 const electronProcess=process as NodeJS.Process & {noAsar?:boolean};
 const previous=electronProcess.noAsar;electronProcess.noAsar=true;
 try{return operation();}finally{electronProcess.noAsar=previous;}
}
export function copyUpdateTree(src:string,dest:string):void {
 withRawFiles(()=>{fs.cpSync(src,dest,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});syncTree(dest);});
}
const snapshot=copyUpdateTree;
function phase(j:UpdateJournal,p:Phase){j.phase=p;writeUpdate(j);}
export async function executeUpdate(root:string,ops:UpdateOperations):Promise<void> {
 const j=readUpdate(root);if(!j||j.phase!=='prepared')throw Error('No prepared update');
 try {
  await ops.preflight(j);await ops.stop(j);
  phase(j,'backing-up');snapshot(j.app,path.join(j.backup,'app'));snapshot(j.data,path.join(j.backup,'data'));
  phase(j,'backed-up');snapshot(j.candidate,j.stagedApp);
  await ops.validateStage?.(j);
  phase(j,'installing');fs.renameSync(j.app,j.displacedApp);fs.renameSync(j.stagedApp,j.app);
  phase(j,'verifying');await ops.verify(j);
  phase(j,'complete');
 }catch(e){
  j.error=e instanceof Error?e.message:String(e);writeUpdate(j);
  if(e && typeof e==='object' && 'unsafeToRestore' in e)phase(j,'recovery-required');
  else if(['installing','verifying','rolling-back'].includes(j.phase))await recoverUpdate(root);
  else phase(j,'failed');
  throw e;
 }
}
export async function recoverUpdate(root:string):Promise<void> {
 const j=readUpdate(root);if(!j||terminalPhase(j.phase))return;
 if(['prepared','backing-up','backed-up'].includes(j.phase)){phase(j,'failed');return;}
 try {
  phase(j,'rolling-back');
  // Recreate recovery staging from immutable backups, so recovery itself is repeatable.
  const suffix=randomUUID(),restoreApp=j.app+'.restore-'+suffix,restoreData=j.data+'.restore-'+suffix;
  snapshot(path.join(j.backup,'app'),restoreApp);snapshot(path.join(j.backup,'data'),restoreData);
  if(fs.existsSync(j.app))fs.renameSync(j.app,j.app+'.failed-'+suffix);
  fs.renameSync(restoreApp,j.app);
  if(fs.existsSync(j.data))fs.renameSync(j.data,j.data+'.failed-'+suffix);
  fs.renameSync(restoreData,j.data);
  phase(j,'rolled-back');
 }catch(e){j.error=(j.error??'')+'; recovery: '+String(e);phase(j,'recovery-required');throw e;}
}
