import * as fs from 'node:fs';
import * as path from 'node:path';
import { executeUpdate, recoverUpdate, readUpdate, writeUpdate, terminalPhase } from './update-transaction';
import { isRecordedProcessAlive, captureProcesses, waitRecordedProcesses, type ValidationProcess, preflight, validateStaged, verifyInstalled, stopOrphanedValidation, command } from './update-mac';
async function main(){
 const root=process.argv[2]!;const recover=process.argv.includes('--recover');
 const j=readUpdate(root);if(!j)throw Error('Missing transaction');
 const lock=path.join(root,'worker.json');
 if(fs.existsSync(lock)){
  const old=JSON.parse(fs.readFileSync(lock,'utf8')) as ValidationProcess;
  if(isRecordedProcessAlive(old))throw Error('An update helper is already running');
  fs.unlinkSync(lock);
 }
 const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(captureProcesses([process.pid])[0]));fs.closeSync(fd);
 try {
  const request=JSON.parse(fs.readFileSync(path.join(j.backup,'request.json'),'utf8')) as {processes:ValidationProcess[]};
  await waitRecordedProcesses(request.processes);
  if(recover){await stopOrphanedValidation(j);await recoverUpdate(root);}
  else await executeUpdate(root,{preflight,stop:async()=>{},validateStage:validateStaged,verify:verifyInstalled});
 }catch(e){
  const latest=readUpdate(root)!;
  latest.error=String(e);writeUpdate(latest);
  // A pre-install failure has not modified the application/data; allow the old client back.
  if(latest.phase==='prepared'){latest.phase='failed';writeUpdate(latest);}
 }finally{
  fs.unlinkSync(lock);
 }
 const result=readUpdate(root)!;
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({phase:result.phase,error:result.error,backup:result.backup}),{mode:0o600});
 if(terminalPhase(result.phase)&&fs.existsSync(result.app))command('/usr/bin/open',['-n','-a',result.app,'--args',`--user-data-dir=${result.data}`]);
}
if(require.main===module)void main().catch(e=>{console.error(e);process.exitCode=1;});
