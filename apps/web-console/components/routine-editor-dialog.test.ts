import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const Dialog = (_props: any) => null;
function setup() {
  const state: any[] = [];
  const effects: Array<() => void> = [];
  const requests: Array<{path:string; body:any}> = [];
  let index = 0, first = true, fail = false;
  let jobs = [{id:'old', name:'Existing job', prompt:'Existing prompt', scheduleKind:'cron5', scheduleValue:'0 9 * * 1-5', enabled:true, metadata:{}, timezone:'UTC'}];
  const react = new Proxy(React, {get(target, key) {
    if (key === 'useState') return (initial:any) => {const n=index++; if(first)state[n]=typeof initial==='function'?initial():initial; return [state[n],(v:any)=>{state[n]=typeof v==='function'?v(state[n]):v;}];};
    if (key === 'useEffect') return (fn:()=>void) => { if(first) effects.push(fn); };
    if (key === 'useMemo') return (fn:()=>unknown) => fn();
    if (key === 'useCallback') return (fn:unknown) => fn;
    return Reflect.get(target,key);
  }});
  const api = async (path:string, init?:{method?:string;body?:string}) => {
    if(init?.method) {
      const body = JSON.parse(init.body!); requests.push({path,body});
      if(fail)throw new Error('Save unavailable');
      jobs = [...jobs,{...jobs[0],id:'new',name:body.name,prompt:body.prompt}];return {};
    }
    if(path.startsWith('/api/cron/jobs?'))return {jobs};
    if(path==='/api/bot-rooms')return {rooms:[]};
    return {settings:{dialogToolsEnabled:true}};
  };
  const source = readFileSync(new URL('./BotCronPanel.tsx',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod={exports:{} as any};
  new Function('require','module','exports',compiled)((id:string)=>{
    if(id==='react')return react;
    if(id==='@/lib/api')return {api};
    if(id==='@/lib/i18n')return {useI18n:()=>({t:(key:string)=>key})};
    if(id==='./RoutineEditorDialog')return {RoutineEditorDialog:Dialog};
    if(id.startsWith('@/lib/'))return require(`../lib/${id.slice(6)}.ts`);
    if(id.startsWith('./'))return new Proxy({}, {get:()=>()=>null});
    return require(id);
  },mod,mod.exports);
  return {
    requests,
    failSave(){fail=true;},
    render(){index=0;const tree=mod.exports.BotCronPanel({botId:'b',botName:'Bot'});first=false;return tree;},
    async load(){for(const effect of effects)effect();await new Promise(resolve=>setImmediate(resolve));}
  };
}
function find(tree:any, predicate:(node:any)=>boolean):any {
  if(!React.isValidElement(tree))return undefined;
  if(predicate(tree))return tree;
  for(const child of React.Children.toArray((tree.props as any).children)){const found=find(child,predicate);if(found)return found;}
}
const dialog=(tree:any)=>find(tree,n=>n.type===Dialog).props;
const click=(tree:any,id:string)=>find(tree,n=>n.props['data-testid']===id).props.onClick();
function input(tree:any,placeholder:string,value:string){find(tree,n=>n.props.placeholder===placeholder).props.onChange({target:{value}});}
async function submit(tree:any){find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));}

test('routine editor opens on request, cancels without saving, and saves back to the list [AC:compact-bot-settings#AC-2]', async()=>{
  const view=setup();view.render();await view.load();let tree=view.render();
  assert.equal(dialog(tree).open,false);
  assert.ok(find(tree,n=>n.props['data-testid']==='bot-detail-routine'));
  click(tree,'routine-add');tree=view.render();assert.equal(dialog(tree).open,true);
  dialog(tree).onClose();tree=view.render();assert.equal(dialog(tree).open,false);assert.deepEqual(view.requests,[]);
  click(tree,'routine-add');tree=view.render();input(tree,'play.cronPanel.namePh','New task');input(tree,'play.cronPanel.promptPh','Check status');
  await submit(view.render());tree=view.render();assert.equal(dialog(tree).open,false);
  assert.equal(view.requests[0].path,'/api/cron/jobs');assert.equal(view.requests[0].body.name,'New task');
  assert.ok(find(tree,n=>n.type==='strong'&&n.props.children==='New task'));
});
test('edit cancellation does not leak into a new task and errors keep the draft [AC:compact-bot-settings#AC-2]',async()=>{
  const view=setup();view.render();await view.load();let tree=view.render();
  find(tree,n=>n.type==='button'&&n.props.children==='botWork.edit').props.onClick();tree=view.render();
  assert.equal(dialog(tree).editingId,'old');assert.equal(dialog(tree).open,true);
  dialog(tree).onClose();click(view.render(),'routine-add');tree=view.render();
  assert.equal(dialog(tree).editingId,null);
  assert.equal(find(tree,n=>n.props.placeholder==='play.cronPanel.promptPh').props.value,'');
  input(tree,'play.cronPanel.namePh','Draft');input(tree,'play.cronPanel.promptPh','Keep me');view.failSave();
  await submit(view.render());tree=view.render();assert.equal(dialog(tree).open,true);assert.equal(dialog(tree).error,'Save unavailable');
  assert.equal(find(tree,n=>n.props.placeholder==='play.cronPanel.promptPh').props.value,'Keep me');
});

test('Escape cancels the native dialog but cannot dismiss a save in flight [AC:compact-bot-settings#AC-2]',()=>{
  let shown=0,closed=0,cancelled=0,prevented=0;
  const react=new Proxy(React,{get(target,key){
    if(key==='useId')return ()=> 'routine-dialog';
    if(key==='useRef')return ()=>({current:{showModal(){shown++;},close(){closed++;}}});
    if(key==='useEffect')return (fn:()=>void)=>fn();
    return Reflect.get(target,key);
  }});
  const compiled=ts.transpileModule(readFileSync(new URL('./RoutineEditorDialog.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod={exports:{} as any};
  new Function('require','module','exports',compiled)((id:string)=>{
    if(id==='react')return react;
    if(id.endsWith('.css'))return {};
    if(id==='@/lib/i18n')return {useI18n:()=>({t:(key:string)=>key})};
    return require(id);
  },mod,mod.exports);
  const props={open:true,editingId:null,busy:false,error:null,onClose(){cancelled++;},children:null};
  const tree=mod.exports.RoutineEditorDialog(props);assert.equal(shown,1);assert.equal(tree.type,'dialog');
  tree.props.onCancel({preventDefault(){prevented++;}});assert.equal(cancelled,1);assert.equal(prevented,1);
  const saving=mod.exports.RoutineEditorDialog({...props,busy:true});saving.props.onCancel({preventDefault(){}});
  assert.equal(cancelled,1);assert.equal(find(saving,n=>n.type==='button').props.disabled,true);
  mod.exports.RoutineEditorDialog({...props,open:false});assert.equal(closed,1);
});

test('editing saves to the selected job and refreshes the list [AC:compact-bot-settings#AC-2]',async()=>{
  const view=setup();view.render();await view.load();let tree=view.render();
  find(tree,n=>n.type==='button'&&n.props.children==='botWork.edit').props.onClick();
  tree=view.render();input(tree,'play.cronPanel.namePh','Updated task');await submit(view.render());
  assert.equal(view.requests[0].path,'/api/cron/jobs/old');assert.equal(view.requests[0].body.prompt,'Existing prompt');
  assert.equal(dialog(view.render()).open,false);
});
