import { chooseUpdate } from './update-prompt';
import { app, dialog, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyUpdateTree, beginUpdate, readUpdate, writeUpdate, terminalPhase } from './update-transaction';
import { readRelease, validateApp, preflight, executable, sanitizeSpawnEnv, isRecordedProcessAlive, captureProcesses } from './update-mac';
const messages={
 zh:{menu:'更新客户端…',select:'选择已验证的新版本 Raw Agent.app',title:'更新客户端',update:'更新客户端',cancel:'取消',current:'当前版本',target:'待更新版本',notes:'更新说明',backup:'更新前将自动备份。失败将恢复旧程序和数据。',busy:'目前有任务或请求正在处理，请结束后重试。',error:'更新未完成',progress:'更新正在进行，请勿启动第二个客户端。',recovery:'上次更新未完成，需要恢复。',recover:'恢复旧版本',folder:'打开备份目录',done:'更新成功',rolled:'更新失败，已恢复旧版本及数据。',manual:'自动恢复未完成。请保留备份，运行恢复入口；恢复前不要手动启动后端。',unsupported:'请在已安装的 macOS Apple Silicon 客户端中更新。',saved:'备份位置',first:'该版本不支持安全更新协议，请选择新生成的更新包。'},
 en:{menu:'Update client…',select:'Select a verified new Raw Agent.app',title:'Update client',update:'Update client',cancel:'Cancel',current:'Current version',target:'New version',notes:'Release notes',backup:'The app and data will be backed up first. Failures restore the previous app and data.',busy:'Tasks or requests are active. Please retry after they finish.',error:'Update did not complete',progress:'Update in progress. Do not launch another client.',recovery:'An interrupted update needs recovery.',recover:'Restore previous version',folder:'Open backup folder',done:'Update succeeded',rolled:'Update failed. Previous app and data restored.',manual:'Automatic recovery is incomplete. Keep the backup and run the recovery launcher before starting any backend.',unsupported:'Use the installed macOS Apple Silicon client to update.',saved:'Backup location',first:'This release does not support safe updates. Select a newly prepared update package.'}
};
export function updateText(){return app.getLocale().startsWith('zh')?messages.zh:messages.en;}
export function updateRoot(){return app.getPath('userData')+'-updates';}
function installedApp(){return path.resolve(process.execPath,'../../..');}
function shellQuote(s:string){return "'"+s.replace(/'/g,"'\\''")+"'";}
function launchWorker(root:string,backup:string,recovery=false):Promise<void>{
 const runner=path.join(backup,'runner.app'),exe=executable(runner),script=path.join(runner,'Contents/Resources/app.asar/dist/update-worker.js');
 const log=fs.openSync(path.join(backup,'update.log'),'a',0o600);
 const child=spawn(exe,[script,root,...(recovery?['--recover']:[])],{detached:true,stdio:['ignore',log,log],env:sanitizeSpawnEnv({ELECTRON_RUN_AS_NODE:'1'})});
 return new Promise((resolve,reject)=>{child.once('error',e=>{fs.closeSync(log);reject(e);});child.once('spawn',()=>{fs.closeSync(log);child.unref();resolve();});});
}
async function prepareDaemon(child:ChildProcess|null):Promise<boolean>{
 if(!child?.connected)return false;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.removeListener('message',handler);reject(Error('Daemon did not acknowledge update barrier'));},10_000);
  function handler(m:unknown){if(m&&typeof m==='object'&&(m as {type?:string}).type==='desktop-update-prepared'){clearTimeout(timer);child!.removeListener('message',handler);resolve((m as {ok:boolean}).ok);}}
  child.on('message',handler);child.send({type:'desktop-update-prepare'});
 });
}
let opening=false;
export async function showUpdate(daemon:()=>ChildProcess|null, web:()=>ChildProcess|null):Promise<void>{
 if(opening)return;opening=true;const t=updateText();
 let prepared=false;
 try {
  if(!app.isPackaged||process.platform!=='darwin'||process.arch!=='arm64')throw Error(t.unsupported);
  const pending=readUpdate(updateRoot());if(pending&&!terminalPhase(pending.phase))throw Error(t.progress);
  const current=installedApp();
  const selected=await chooseUpdate({
    select:async()=>{const pick=await dialog.showOpenDialog({title:t.select,properties:['openFile'],filters:[{name:'Raw Agent',extensions:['app']}]});return pick.canceled||!pick.filePaths[0]?undefined:fs.realpathSync(pick.filePaths[0]);},
    preview:candidate=>{const next=validateApp(candidate),prev=readRelease(current);return {current:prev.version+' '+prev.buildId,target:next.version+' '+next.buildId,notes:next.notes};},
    confirm:async preview=>(await dialog.showMessageBox({type:'info',title:t.title,message:t.title,detail:preview.current+' → '+preview.target+'\n\n'+t.notes+': '+preview.notes+'\n\n'+t.backup,buttons:[t.cancel,t.update],defaultId:0,cancelId:0})).response===1
  });
  if(!selected)return;
  const input={root:updateRoot(),app:current,candidate:selected.candidate,data:app.getPath('userData'),currentVersion:selected.preview.current,targetVersion:selected.preview.target,notes:selected.preview.notes};
  // Preflight before requesting the runtime barrier, so invalid packages don't interrupt service.
  fs.mkdirSync(updateRoot(), {recursive:true,mode:0o700});
  await preflight({...input,id:'preview',phase:'prepared',backup:updateRoot(),stagedApp:current+'.preview',displacedApp:current+'.preview-old'});
  const j=await beginUpdate(input,async()=>{prepared=true;const ok=await prepareDaemon(daemon());if(!ok)throw Error(t.busy);return true;});
  // The helper must survive replacement of the installed app and OS restarts.
  copyUpdateTree(current,path.join(j.backup,'runner.app'));
  const runner=path.join(j.backup,'runner.app');
  fs.writeFileSync(path.join(j.backup,'request.json'),JSON.stringify({processes:captureProcesses([process.pid,...app.getAppMetrics().map(p=>p.pid),...(daemon()?.pid?[daemon()!.pid!]:[]),...(web()?.pid?[web()!.pid!]:[])])}),{mode:0o600});
  const recovery=path.join(j.backup,'Recover.command');
  fs.writeFileSync(recovery,`#!/bin/sh\nexec /usr/bin/env -i HOME=${shellQuote(app.getPath('home'))} PATH=/usr/bin:/bin ELECTRON_RUN_AS_NODE=1 ${shellQuote(executable(runner))} ${shellQuote(path.join(runner,'Contents/Resources/app.asar/dist/update-worker.js'))} ${shellQuote(j.root)} --recover\n`,{mode:0o700});
  fs.writeFileSync(path.join(j.backup,'RECOVERY.txt'),`${t.saved}: ${j.backup}\n${t.manual}\n${recovery}\n`,{mode:0o600});
  await launchWorker(j.root,j.backup);
  app.quit();
 }catch(e){
  if(prepared){daemon()?.send({type:'desktop-update-cancel'});const j=readUpdate(updateRoot());if(j?.phase==='prepared'){j.phase='failed';j.error=String(e);writeUpdate(j);}}
  await dialog.showMessageBox({type:'error',title:t.title,message:t.error,detail:String(e)});
 }finally{opening=false;}
}
/** Run before creating any window or service. Pending updates never open the database. */
export async function checkUpdateStartup():Promise<boolean>{
 const t=updateText(),root=updateRoot();const j=readUpdate(root);
 if(j&&!terminalPhase(j.phase)){
  const worker=path.join(root,'worker.json');
  if(fs.existsSync(worker)&&isRecordedProcessAlive(JSON.parse(fs.readFileSync(worker,'utf8')))){
   await dialog.showMessageBox({message:t.progress});return false;
  }
  const answer=await dialog.showMessageBox({type:'warning',message:t.recovery,detail:`${t.saved}: ${j.backup}\n${t.manual}`,buttons:[t.cancel,t.recover,t.folder],cancelId:0,defaultId:1});
  if(answer.response===1){fs.writeFileSync(path.join(j.backup,'request.json'),JSON.stringify({processes:captureProcesses([process.pid])}));await launchWorker(root,j.backup,true);}
  if(answer.response===2)await shell.openPath(j.backup);
  return false;
 }
 const result=path.join(root,'result.json');
 if(fs.existsSync(result)){
  const r=JSON.parse(fs.readFileSync(result,'utf8'));
  await dialog.showMessageBox({type:r.phase==='complete'?'info':'warning',message:r.phase==='complete'?t.done:r.phase==='rolled-back'?t.rolled:t.error,detail:`${r.error??''}\n${t.saved}: ${r.backup}`});
  fs.renameSync(result,path.join(root,'last-result.json'));
 }
 return true;
}
