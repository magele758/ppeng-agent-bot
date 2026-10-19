import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const source=readFileSync(new URL('../src/factory/development-worker.ts',import.meta.url),'utf8').split('String.raw`')[1].split('\n`;')[0];
function python(t, body, docker='') {
 const home=realpathSync(mkdtempSync(join(tmpdir(),'factory-dev-security-')));
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 mkdirSync(join(home,'bin'));
 writeFileSync(join(home,'bin/docker'),'#!/usr/bin/env python3\nimport sys,os,json\n'+docker,{mode:0o755});
 const code=`import os,json,pathlib\nns={'__name__':'test'}\nexec(${JSON.stringify(source.split("if len(sys.argv)>2")[0])},ns)\nns['identity']=lambda:'machine-id'\nns['git_env']=lambda:dict(os.environ,PATH=os.environ['HOME']+'/bin:'+os.environ['PATH'])\np={'timeoutMs':10000,'revision':'p','image':'sha256:'+'a'*64,'toolPath':os.environ['HOME']+'/tool','model':'test'}\nr={'task':{'id':'factory_security','identity':'machine-id','development':{'generation':1,'policy':p}}}\nd=pathlib.Path(os.environ['HOME'])/'task';d.mkdir()\nc=ns['Controller'](r,d)\nc.work.mkdir()\n${body}`;
 const result=spawnSync('python3',['-I','-c',code],{env:{...process.env,HOME:home},encoding:'utf8',timeout:20000});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
test('unconfirmed container termination cannot yield a finished task receipt',t=>{
 const r=python(t,`c.run=lambda:(c.command(['true']),c.save('READY','succeeded',True))\nc.execute()\nprint(c.record.read_text())`,"if sys.argv[1]=='run':print('done')\nelif sys.argv[1]=='rm':sys.exit(1)\nelif sys.argv[1]=='inspect':print('true')\n");
 assert.equal(r.finished,false);assert.equal(r.status,'unknown');
});
test('plain task commands cannot use the model broker lease',t=>{
 const r=python(t,`from types import SimpleNamespace\nc.broker=SimpleNamespace(active=True)\nc.command(['true'])\nprint(json.dumps({'active':c.broker.active}))`,"if sys.argv[1]=='run':print('done')\nelif sys.argv[1]=='inspect':print('false')\n");
 assert.equal(r.active,false);
});
test('safe directory refuses symlink ancestors before creating outside directories',t=>{
 const r=python(t,`outside=pathlib.Path(os.environ['HOME'])/'outside';outside.mkdir()\nlink=pathlib.Path(os.environ['HOME'])/'link';link.symlink_to(outside,target_is_directory=True)\ntry:ns['safe_dir'](link/'created')\nexcept ValueError:pass\nprint(json.dumps({'created':(outside/'created').exists()}))`);
 assert.equal(r.created,false);
});
test('checks reject skipped required cases even when check exit is zero',t=>{
 const r=python(t,`c.p['checks']=[{'id':'unit','argv':['node','test.js'],'required':True}]\nc.p['baselineFailures']=[]\nprint(json.dumps(c.checks('a'*40)))`,"if sys.argv[1]=='run':print('ok 1 - missing # SKIP\\n# tests 1\\n# skipped 1')\nelif sys.argv[1]=='inspect':print('false')\n");
 assert.equal(r[0].passed,false);
});
test('model broker rebuilds authentication and redacts upstream credential echoes',t=>{
 const r=python(t,`import http.server,threading,urllib.request\nseen=[]\nclass Upstream(http.server.BaseHTTPRequestHandler):\n def log_message(self,*args):pass\n def do_POST(self):\n  b=json.loads(self.rfile.read(int(self.headers['content-length'])))\n  seen.append({'auth':self.headers.get('authorization'),'model':b['model']})\n  self.send_response(200);self.end_headers();self.wfile.write(b'{"echo":"private-upstream-key"}')\nu=http.server.HTTPServer(('127.0.0.1',0),Upstream);threading.Thread(target=u.serve_forever,daemon=True).start()\nb=http.server.HTTPServer(('127.0.0.1',0),ns['ModelBroker']);b.policy={'model':'pinned','modelUrl':'http://127.0.0.1:'+str(u.server_port)};b.key='private-upstream-key';b.active=True;b.calls=0;b.slots=threading.BoundedSemaphore(2)\nthreading.Thread(target=b.serve_forever,daemon=True).start()\nreq=urllib.request.Request('http://127.0.0.1:'+str(b.server_port)+'/v1/messages',data=b'{"model":"attacker","max_tokens":1}',headers={'authorization':'Bearer forged'},method='POST')\nout=urllib.request.urlopen(req).read().decode()\nreq2=urllib.request.Request(req.full_url+'?beta=true',data=req.data,method='POST')\nwith urllib.request.urlopen(req2) as response:response.read()\nblocked=0\ntry:urllib.request.urlopen(urllib.request.Request(req.full_url+'?target=http://evil',data=req.data,method='POST'))\nexcept urllib.error.HTTPError as e:blocked=e.code\nb.shutdown();u.shutdown()\nprint(json.dumps({'seen':seen,'response':out,'blocked':blocked}))`);
 assert.equal(r.seen[0].auth,'Bearer private-upstream-key');assert.equal(r.seen[0].model,'pinned');assert.doesNotMatch(r.response,/private-upstream-key/);assert.equal(r.seen.length,2);assert.equal(r.blocked,403);
});
test('resume preserves immutable red evidence and repair checkpoint from finished generation',t=>{
 const r=python(t,`old={'status':'failed','finished':True,'result':{'development':{'generation':1,'stage':'WAITING_DECISION','round':3,'policyRevision':'p','red':{'testDigest':'frozen'},'protectedDigest':'protected','manifest':{'baseline':'a'*40}}}}\nns['atomic'](d/'receipt-1.json',old)\nr['task']['development'].update(generation=2,round=3,baseline='a'*40)\nc2=ns['Controller'](r,d)\nprint(json.dumps(c2.state))`);
 assert.equal(r.red?.testDigest,'frozen');assert.equal(r.round,3);assert.equal(r.generation,2);
});
test('preflight rejects a Docker daemon whose isolated runtime cannot execute',t=>{
 const r=python(t,`p.update(minDiskMb=0,checks=[{'id':'test'}],criteriaApproved=True)\nns['credentials']=lambda p:'key'\nprint(json.dumps(ns['preflight']({'policy':p,'repositoryPath':str(d),'baseline':'a'*40})))`,"if sys.argv[1]=='run':sys.exit(1)\nelse:print('available')\n");
 assert.equal(r.checks.find(x=>x.id==='runtime')?.ok,false);
});
test('model preflight rejects credentials refused by the actual upstream',t=>{
 const r=python(t,`import http.server,threading\nclass Refused(http.server.BaseHTTPRequestHandler):\n def log_message(self,*args):pass\n def do_POST(self):self.send_response(403);self.end_headers()\nu=http.server.HTTPServer(('127.0.0.1',0),Refused);threading.Thread(target=u.serve_forever,daemon=True).start()\np.update(modelUrl='http://127.0.0.1:'+str(u.server_port),minDiskMb=0,checks=[{'id':'test'}],criteriaApproved=True)\nns['credentials']=lambda p:'refused-key'\nresult=ns['preflight']({'policy':p,'repositoryPath':str(d),'baseline':'a'*40})\nu.shutdown();print(json.dumps(result))`,"print('available')\n");
 assert.equal(r.checks.find(x=>x.id==='model')?.ok,false);
});
test('workspace overflow stops execution and never emits READY',t=>{
 const r=python(t,`c.run=lambda:(c.command(['true']),c.save('READY','succeeded',True))\nc.execute();print(c.record.read_text())`,"if sys.argv[1]=='run':\n import time\n with open(os.environ['HOME']+'/task/work/huge','wb') as f:f.truncate(1073741825)\n time.sleep(1.5)\n print('done')\n");
 assert.equal(r.result.development.stage,'DEFERRED');assert.match(r.error,/storage limit/);
});
test('cancellation records terminal result only after container cleanup',t=>{
 const r=python(t,`c.run=lambda:(c.command(['true']),c.save('READY','succeeded',True))\nc.execute();print(c.record.read_text())`,"if sys.argv[1]=='run':\n import time\n with open(os.environ['HOME']+'/task/control-1.json','w') as f:json.dump({'action':'cancel'},f)\n time.sleep(.5)\n");
 assert.equal(r.status,'cancelled');assert.equal(r.finished,true);
});
test('red controller refuses production edits before behavioral failure evidence',t=>{
 const r=python(t,`p.update(codeArgv=['tool'],maxRetries=0,criteria=[{'id':'AC-1'}],redCheck='unit',checks=[{'id':'unit','argv':['test']}])\nc.spec.update(requirement='fix behavior',baseline='a'*40)\ntry:c.red();result='accepted'\nexcept ns['Deferred'] as e:result=str(e)\nprint(json.dumps({'result':result}))`,"if sys.argv[1]=='run':\n a=json.loads(sys.argv[-2])\n if a[0]=='python3':print(json.dumps({'digest':'tests','protected':'gates','files':[['test.js','sha']]}))\n elif 'diff' in a:print('src/app.js')\n");
 assert.match(r.result,/Production code changed/);
});
test('detached trusted controller inherits host HOME without exposing ambient secrets',t=>{
 const r=python(t,`import time\nns['_SOURCE']="import os,sys,pathlib;pathlib.Path(sys.argv[2]).parent.joinpath('observed-home').write_text(os.environ.get('HOME','')+'|'+os.environ.get('SHOULD_NOT_PASS','missing'))"\nns['git_env']=lambda:{'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/nonexistent'}\nos.environ['SHOULD_NOT_PASS']='ambient-secret'\nns['preflight']=lambda req:{'ready':True,'checks':[]}\nr.update(action='start');r['task'].update(identity='machine-id',repositoryPath=str(d));r['task']['development']['baseline']='a'*40\nns['dispatch'](r)\nobserved=ns['ROOT']/'factory_security'/'observed-home'\nfor _ in range(100):\n if observed.exists():break\n time.sleep(.02)\nprint(json.dumps({'home':observed.read_text(),'expected':os.environ['HOME']+'|missing'}))`);
 assert.equal(r.home,r.expected);
});
test('red evidence requires exact criterion IDs rather than prefix substring matches',t=>{
 const r=python(t,`p.update(codeArgv=['tool'],maxRetries=0,criteria=[{'id':'AC-1'},{'id':'AC-10'}],redCheck='unit',checks=[{'id':'unit','argv':['test']}])\nc.spec.update(requirement='fix behavior',baseline='a'*40)\ntry:c.red();result='accepted'\nexcept ns['Deferred'] as e:result=str(e)\nprint(json.dumps({'result':result}))`,"if sys.argv[1]=='run':\n a=json.loads(sys.argv[-2])\n if a[0]=='python3':print(json.dumps({'digest':'tests','protected':'gates','files':[['test.js','sha']]}))\n elif 'diff' in a:print('test/test.js')\n elif a[0]=='test':print('not ok 1 - AC-10 AssertionError expected true');sys.exit(1)\n");
 assert.match(r.result,/Behavioral red test evidence missing/);
});
test('model broker binds a real socket even when persistent task path exceeds UNIX limit',t=>{
 const r=python(t,`long=d/('nested-task-path-'*10);long.mkdir()\nc2=ns['Controller'](r,long)\nserver=None\ntry:\n server=ns['UnixServer'](str(c2.broker_dir/'model.sock'),ns['ModelBroker']);result={'bound':True,'length':len(str(c2.broker_dir/'model.sock').encode())}\nexcept OSError as e:result={'bound':False,'error':str(e)}\nfinally:\n if server:server.server_close();(c2.broker_dir/'model.sock').unlink(missing_ok=True)\nprint(json.dumps(result))`);
 assert.equal(r.bound,true,r.error);assert.ok(r.length<104);
});
test('trusted artifact import accepts only exact dependency SHA and verified bounded bytes',t=>{
 const r=python(t,`import base64,hashlib\nr.update(action='import-artifact');r['task']['development']['dependency']={'sha':'b'*40,'taskId':'factory_source'}\ndata=b'# v2 git bundle\\nfixture'\nr['artifact']={'sha':'b'*40,'baseline':'a'*40,'digest':hashlib.sha256(data).hexdigest(),'bytes':len(data),'base64':base64.b64encode(data).decode()}\ntry:result=ns['dispatch'](r)\nexcept Exception as e:result={'error':type(e).__name__}\nprint(json.dumps(result))`);
 assert.equal(r.sha,'b'.repeat(40));assert.equal(r.bytes,23);assert.equal(r.base64,undefined);
});
test('trusted artifact export reads exact READY generation without exposing bundle in receipts',t=>{
 const r=python(t,`import base64,hashlib\nroot=ns['safe_dir'](ns['ROOT']/'factory_security');data=b'# v2 git bundle\\nfixture'\n(root/'artifact-1.bundle').write_bytes(data)\nmetadata={'sha':'b'*40,'baseline':'a'*40,'digest':hashlib.sha256(data).hexdigest(),'bytes':len(data)}\nns['atomic'](root/'receipt-1.json',{'status':'succeeded','finished':True,'result':{'development':{'stage':'READY','sha':'b'*40,'artifact':metadata}}})\nr.update(action='artifact',sha='b'*40)\ntry:result=ns['dispatch'](r)\nexcept Exception as e:result={'error':type(e).__name__}\nprint(json.dumps(result))`);
 assert.equal(r.sha,'b'.repeat(40));assert.ok(r.base64);assert.equal(r.path,undefined);
});
test('artifact exporter executes real Git delta bundle creation at exact commit',t=>{
 const r=python(t,`git=lambda *a:ns['host'](['git','-C',str(c.work),*a])\ngit('init','-q');git('config','user.name','Test');git('config','user.email','test@example.test')\n(c.work/'app.js').write_text('old');git('add','.');git('commit','-qm','base');base=git('rev-parse','HEAD')\n(c.work/'app.js').write_text('new');git('add','.');git('commit','-qm','result');sha=git('rev-parse','HEAD')\nexport=ns['EXPORT'].replace('/tmp/dependency.bundle',str(d/'export.bundle'))\nresult=ns['subprocess'].run([ns['sys'].executable,'-I','-c',export,base,sha],cwd=c.work,env=ns['git_env'](),capture_output=True,text=True,check=True)\nenvelope=json.loads(result.stdout);data,meta=ns['bundle_envelope'](envelope,sha)\nverify=git('bundle','verify',str(d/'export.bundle'))\nprint(json.dumps({'sha':meta['sha'],'expected':sha,'bytes':len(data),'valid':bool(verify)}))`);
 assert.equal(r.sha,r.expected);assert.ok(r.bytes>100);assert.equal(r.valid,true);
});
test('artifact import rejects corrupted digest and wrong physical host identity',t=>{
 const r=python(t,`import base64\nr.update(action='import-artifact');r['task']['development']['dependency']={'sha':'b'*40}\nr['artifact']={'sha':'b'*40,'baseline':'a'*40,'digest':'0'*64,'bytes':23,'base64':base64.b64encode(b'# v2 git bundle\\nfixture').decode()}\nerrors=[]\nfor ident in ('machine-id','other-host'):\n r['task']['identity']=ident\n try:ns['dispatch'](r);errors.append('accepted')\n except ValueError as e:errors.append(str(e))\nprint(json.dumps(errors))`);
 assert.match(r[0],/integrity/);assert.match(r[1],/host identity/);
});
test('failed coding attempt is durably visible before the next retry starts',t=>{
 const r=python(t,`p.update(codeArgv=['tool'],maxRetries=1)\nc.logs.append('earlier phase evidence');c.save('RED')\nprint(c.agent('write tests'))`,"if sys.argv[1]=='run':\n flag=os.environ['HOME']+'/attempt'\n if not os.path.exists(flag):\n  open(flag,'w').close();print('tool failed at turn limit');sys.exit(7)\n else:\n  receipt=json.load(open(os.environ['HOME']+'/task/receipt-1.json'))\n  print(json.dumps(receipt['result']['development']))\n");
 assert.match(r.log,/earlier phase evidence/);assert.match(r.log,/tool failed at turn limit/);assert.equal(r.stage,'RED');assert.equal(r.toolFailure.exitCode,7);assert.equal(r.toolFailure.attempt,1);
});
test('successful TAP summaries with zero skipped and todo cases pass required checks',t=>{
 const r=python(t,`c.p.update(checks=[{'id':'unit','argv':['test'],'required':True}],baselineFailures=[])\nprint(json.dumps(c.checks('a'*40)))`,"if sys.argv[1]=='run':print('ok 1 - behavior\\n# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0\\n# todo 0')\n");
 assert.equal(r[0].passed,true);assert.equal(r[0].skipped,false);
});
test('silent successful checks preserve canonical controller execution evidence',t=>{
 const r=python(t,`c.p.update(checks=[{'id':'typecheck','argv':['tsc'],'required':True}],baselineFailures=[])\nprint(json.dumps(c.checks('a'*40)))`,"pass\n");
 assert.equal(r[0].passed,true);assert.equal(r[0].executed,true);assert.equal(r[0].outputEmpty,true);assert.equal(r[0].output,'(no output; exited 0)');
});
test('check evidence explicitly marks bounded output truncation',t=>{
 const r=python(t,`c.p.update(checks=[{'id':'unit','argv':['test'],'required':True}],baselineFailures=[])\nprint(json.dumps(c.checks('a'*40)))`,"if sys.argv[1]=='run':print('x'*40000)\n");
 assert.equal(r[0].outputTruncated,true);assert.equal(r[0].output.length,32768);
});
test('review protocol reads stdout JSON separately from native CLI stderr warnings',t=>{
 const r=python(t,`p.update(reviewArgv=['tool'],maxRetries=0,criteria=[{'id':'AC-1'}])\nc.spec.update(requirement='fix behavior',baseline='a'*40)\ntry:review=c.review('b'*40)\nexcept ns['Deferred'] as e:review={'error':str(e)}\nprint(json.dumps({'review':review,'log':'\\n'.join(c.logs)}))`,"if sys.argv[1]=='run':\n a=json.loads(sys.argv[-2])\n if a[0]=='git':print('src/app.js')\n else:\n  print('[claude-code:unrecognized_model] warning',file=sys.stderr)\n  print(json.dumps({'type':'result','is_error':False,'subtype':'success','result':json.dumps({'verdict':'CLEAN','issues':[]})}))\n");
 assert.equal(r.review.verdict,'CLEAN');assert.match(r.log,/unrecognized_model/);
});
test('review rejects CLI error envelopes even if result contains a CLEAN verdict',t=>{
 const r=python(t,`p.update(reviewArgv=['tool'],maxRetries=0,criteria=[{'id':'AC-1'}])\nc.spec.update(requirement='fix behavior',baseline='a'*40)\ntry:result=c.review('b'*40)\nexcept ns['Deferred'] as e:result={'error':str(e)}\nprint(json.dumps(result))`,"if sys.argv[1]=='run':\n a=json.loads(sys.argv[-2])\n if a[0]=='git':print('src/app.js')\n else:print(json.dumps({'type':'result','is_error':True,'subtype':'error_max_turns','result':json.dumps({'verdict':'CLEAN','issues':[]})}))\n");
 assert.match(r.error,/budget exhausted/);assert.equal(r.verdict,undefined);
});
test('whole repair stage history survives final receipt and remains append-only on disk',t=>{
 const r=python(t,`for stage in ('RED','FIX','TEST','REVIEW','READY'):\n if stage=='FIX':c.round=1\n c.save(stage)\npath=d/'events-1.jsonl'\nprint(json.dumps({'timeline':c.state.get('timeline',[]),'events':path.read_text().splitlines() if path.exists() else []}))`);
 assert.deepEqual(r.timeline.map(e=>e.stage),['RED','FIX','TEST','REVIEW','READY']);assert.equal(r.events.length,5);assert.equal(r.timeline[2].round,1);
});
test('command stdout and stderr have durable bounded evidence while private bundle data stays private',t=>{
 const r=python(t,`import hashlib\nc.command(['tool'],model=True)\nc.command(['tool'],private=True)\nc.save('DEV')\nrows=[]\nfor item in c.state.get('artifacts',{}).values():\n if item.get('kind')=='command-output':\n  data=(d/item['name']).read_bytes();rows.append({'name':item['name'],'text':data.decode(),'valid':hashlib.sha256(data).hexdigest()==item['digest']})\nprint(json.dumps(rows))`,"if sys.argv[1]=='run':\n if sys.argv[-1]=='plain':print('private-bundle-canary')\n else:print('phase stdout');print('phase warning',file=sys.stderr)\n");
 assert.equal(r.length,2);assert.ok(r.every(x=>x.valid&&!x.name.includes('/')));assert.ok(r.some(x=>x.text.includes('phase stdout')));assert.ok(r.some(x=>x.text.includes('phase warning')));assert.ok(r.every(x=>!x.text.includes('private-bundle-canary')));
});
test('policy replacement workspace is resumed by actual directory on later generations',t=>{
 const r=python(t,`work=d/'work-2';work.mkdir();(work/'implementation').write_text('new-policy-code')\nold={'status':'failed','finished':True,'result':{'development':{'generation':2,'stage':'DEFERRED','checkpointStage':'TEST','round':2,'policyRevision':'p','red':{'testDigest':'new-frozen'},'manifest':{'baseline':'a'*40,'path':str(work)}}}}\nns['atomic'](d/'receipt-2.json',old)\nr['task']['development'].update(generation=3,round=2,baseline='a'*40)\nc3=ns['Controller'](r,d)\nns['atomic'](d/'receipt-3.json',{'status':'failed','finished':True,'result':{'development':{**c3.state,'stage':'WAITING_DECISION','round':6}}})\nr['task']['development'].update(generation=4,round=6)\nc4=ns['Controller'](r,d)\nprint(json.dumps({'resume':str(c3.work),'addRounds':str(c4.work),'expected':str(work),'red':c4.state['red'],'code':(c4.work/'implementation').read_text() if (c4.work/'implementation').exists() else None}))`);
 assert.equal(r.resume,r.expected);assert.equal(r.addRounds,r.expected);assert.equal(r.red.testDigest,'new-frozen');assert.equal(r.code,'new-policy-code');
});
test('resuming a saved workspace refuses escaped or symlink manifest paths',t=>{
 const r=python(t,`outside=d.parent/'outside';outside.mkdir();link=d/'work-2';link.symlink_to(outside,target_is_directory=True)\nrefused=[]\nfor saved in (str(outside),str(link),str(d/'missing'),str(d/'work-999'),str(d/'work-2'/'..'/'work')):\n old={'status':'failed','finished':True,'result':{'development':{'generation':2,'stage':'DEFERRED','policyRevision':'p','manifest':{'baseline':'a'*40,'path':saved}}}}\n ns['atomic'](d/'receipt-2.json',old)\n r['task']['development'].update(generation=3,baseline='a'*40)\n try:ns['Controller'](r,d);refused.append(False)\n except ValueError:refused.append(True)\nprint(json.dumps({'refused':refused}))`);
 assert.deepEqual(r.refused,[true,true,true,true,true]);
});
test('dead controller status advances receipt sequence and service retains occupied unknown work',async t=>{
 const r=python(t,`folder=ns['safe_dir'](ns['ROOT']/r['task']['id'])\nreceipt={'status':'running','seq':5,'identity':'host-u0','finished':False,'pid':999999999,'processToken':'old-process','result':{'development':{'generation':1,'stage':'TEST','round':0}}}\nns['atomic'](folder/'receipt-1.json',receipt)\nr['action']='status'\nfirst=ns['dispatch'](r);second=ns['dispatch'](r)\nprint(json.dumps({'first':first,'second':second,'stored':ns['read_json'](folder/'receipt-1.json')}))`);
 assert.equal(r.first.status,'unknown');assert.equal(r.first.seq,6);assert.equal(r.second.seq,6);assert.equal(r.stored.seq,5);
 const {fixture}=await import('./factory-development-fixture.js');const f=await fixture(t,[1,1]);const task=f.submit();task.status='running';task.seq=5;task.identity='host-u0';task.development={generation:1,stage:'TEST',round:0,policy:{maxRounds:6}};f.service.updateDevelopment(task);
 f.service.acceptReport(task.id,r.first);assert.equal(f.service.get(f.principal,task.id).status,'unknown');assert.equal(f.service.board(f.principal).machines[0].occupied,1);
 f.service.acceptReport(task.id,{...r.first,status:'running',result:{development:{generation:1,stage:'FIX',round:1}}});assert.equal(f.service.get(f.principal,task.id).status,'unknown');assert.equal(f.service.get(f.principal,task.id).development.stage,'TEST');
});
test('live controller polling leaves the progress sequence unchanged',t=>{
 const r=python(t,`ns['process_token']=lambda pid:'live-token' if pid==os.getpid() else None\nfolder=ns['safe_dir'](ns['ROOT']/r['task']['id'])\nreceipt={'status':'running','seq':5,'identity':'machine-id','finished':False,'pid':os.getpid(),'processToken':ns['process_token'](os.getpid()),'result':{'development':{'generation':1,'stage':'TEST','round':0}}}\nns['atomic'](folder/'receipt-1.json',receipt)\nr['action']='status'\nprint(json.dumps(ns['dispatch'](r)))`);
 assert.equal(r.status,'running');assert.equal(r.seq,5);
});
function issueReviews(t,responses){
 return python(t,`p.update(reviewArgv=['tool'],maxRetries=0,criteria=[{'id':'AC-1'}])\nc.spec.update(requirement='fix behavior',baseline='a'*40)\npathlib.Path(os.environ['HOME']).joinpath('reviews.json').write_text(${JSON.stringify(JSON.stringify(responses))})\nresults=[]\nfor i in range(${responses.length}):\n sha=('b' if i==0 else 'c')*40\n c.state['review']=c.review(sha);results.append(c.state['review'])\nprint(json.dumps(results))`,"if sys.argv[1]=='run':\n a=json.loads(sys.argv[-2])\n if a[0]=='git':print('src/app.js')\n else:\n  path=os.environ['HOME']+'/review-index'\n  index=int(open(path).read()) if os.path.exists(path) else 0\n  open(path,'w').write(str(index+1))\n  print(json.dumps(json.load(open(os.environ['HOME']+'/reviews.json'))[index]))\n");
}
const blocker={id:'B1',severity:'P1',description:'Missing access control',closed:false};
test('review ledger retains omitted P1 and P2 across a later CLEAN response',t=>{
 const r=issueReviews(t,[{verdict:'BLOCKING',issues:[blocker,{id:'N1',severity:'P2',description:'Minor diagnostic issue',closed:false}]},{verdict:'CLEAN',issues:[]}]);
 assert.equal(r[1].verdict,'BLOCKING');assert.deepEqual(r[1].issues.map(x=>x.id).sort(),['B1','N1']);
});
test('independent review can close known blocker with explicit current-commit evidence',t=>{
 const closed={...blocker,closed:true,reason:'Authorization enforced',evidence:'Negative access test passes and branch inspected',evidenceSha:'c'.repeat(40)};
 const r=issueReviews(t,[{verdict:'BLOCKING',issues:[blocker]},{verdict:'CLEAN',issues:[closed]}]);
 assert.equal(r[1].verdict,'CLEAN');assert.equal(r[1].issues[0].closed,true);assert.equal(r[1].issues[0].evidenceSha,'c'.repeat(40));
});
test('review cannot close blocker without evidence or by downgrading severity',t=>{
 const r=issueReviews(t,[{verdict:'BLOCKING',issues:[blocker]},{verdict:'CLEAN',issues:[{...blocker,severity:'P2',closed:true}]}]);
 assert.equal(r[1].verdict,'BLOCKING');assert.equal(r[1].issues[0].severity,'P1');assert.equal(r[1].issues[0].closed,false);
});
test('policy refresh retains unresolved prior-generation issues for independent revalidation',t=>{
 const r=python(t,`p.update(reviewArgv=['tool'],maxRetries=0,criteria=[{'id':'AC-1'}])\nr['task']['development'].update(baseline='a'*40,requirement='fix behavior',generation=2)\nns['atomic'](d/'receipt-1.json',{'finished':True,'result':{'development':{'policyRevision':'old','manifest':{'baseline':'a'*40},'review':{'issues':[{'id':'B1','severity':'P1','description':'Missing authorization','closed':False}]}}}})\nc2=ns['Controller'](r,d);print(json.dumps(c2.review('c'*40)))`,"if sys.argv[1]=='run':\n a=json.loads(sys.argv[-2])\n if a[0]=='git':print('src/app.js')\n else:print(json.dumps({'verdict':'CLEAN','issues':[]}))\n");
 assert.equal(r.verdict,'BLOCKING');assert.equal(r.issues[0].id,'B1');
});
test('large evidence metadata has an explicit bounded window while files and current references remain',t=>{
 const r=python(t,`for index in range(2000):\n name='command-old-'+str(index)+'-stdout.txt';c.artifacts[name]={'kind':'command-output','name':name,'digest':'a'*64,'bytes':10,'detail':'x'*200}\nname='current-required.txt';(d/name).write_text('kept output');c.artifacts[name]={'kind':'command-output','name':name,'digest':'b'*64,'bytes':11}\nc.state['checks']=[{'id':'required','sha':'c'*40,'evidence':{'stdout':name}}]\nc.save('REVIEW')\nprint(json.dumps({'bytes':len(json.dumps(c.state['artifacts']).encode()),'count':len(c.state['artifacts']),'truncated':c.state.get('artifactsTruncated'),'current':name in c.state['artifacts'],'file':(d/name).read_text(),'journal':(d/'events-1.jsonl').exists()}))`);
 assert.equal(r.truncated,true);assert.ok(r.bytes<=262144);assert.ok(r.count<=512);assert.equal(r.current,true);assert.equal(r.file,'kept output');assert.equal(r.journal,true);
});
test('oversized receipt preserves a private snapshot and publishes bounded DEFERRED instead of READY',t=>{
 const r=python(t,`c.state['review']={'issues':[{'id':'B'+str(i),'description':'x'*10000,'severity':'P2'} for i in range(220)]}\ntry:c.save('READY','succeeded',True)\nexcept Exception:pass\nreceipt=json.loads(c.record.read_text());state=receipt['result']['development'];meta=state.get('snapshot',{})\nprint(json.dumps({'bytes':c.record.stat().st_size,'status':receipt['status'],'finished':receipt['finished'],'stage':state['stage'],'snapshot':(d/meta['name']).exists() if meta.get('name') else False,'overflow':state.get('receiptOverflow')}))`);
 assert.equal(r.stage,'DEFERRED');assert.equal(r.status,'failed');assert.equal(r.finished,true);assert.equal(r.overflow,true);assert.equal(r.snapshot,true);assert.ok(r.bytes<1572864);
});
test('oversized unconfirmed execution stays unknown without releasing capacity',t=>{
 const r=python(t,`c.container='still-unverified';c.state['review']={'issues':[{'id':'B'+str(i),'description':'x'*10000,'severity':'P2'} for i in range(220)]}\ntry:c.save('VERIFYING','unknown',False)\nexcept Exception:pass\nreceipt=json.loads(c.record.read_text());print(json.dumps({'bytes':c.record.stat().st_size,'status':receipt['status'],'finished':receipt['finished'],'stage':receipt['result']['development']['stage']}))`);
 assert.equal(r.status,'unknown');assert.equal(r.finished,false);assert.equal(r.stage,'VERIFYING');assert.ok(r.bytes<1572864);
});
test('overflow generations cannot resume after a policy change and lose saved blockers',t=>{
 const r=python(t,`c.state['issueLedger']=[{'id':'OLD-P1','severity':'P1','description':'x'*1700000,'closed':False}]\ntry:c.save('DEFERRED','failed',True)\nexcept Exception:pass\noriginal=json.loads(c.record.read_text());snapshot=original['result']['development']['snapshot'];saved=json.loads((d/snapshot['name']).read_text())\np['revision']='new-policy';r['task']['development'].update(generation=2,baseline='a'*40)\nc2=ns['Controller'](r,d);c2.execute();current=json.loads(c2.record.read_text())\nprint(json.dumps({'stage':current['result']['development']['stage'],'error':current.get('error'),'blockerSaved':saved['result']['development']['issueLedger'][0]['id']=='OLD-P1'}))`);
 assert.equal(r.stage,'DEFERRED');assert.match(r.error,/evidence.*recover/i);assert.equal(r.blockerSaved,true);
});
test('fresh target machine retains carried blockers without prior receipt files',t=>{
 const r=python(t,`p.update(reviewArgv=['tool'],maxRetries=0,criteria=[{'id':'AC-1'}])\nr['task']['development'].update(generation=2,baseline='a'*40,requirement='fix behavior',reviewCarry={'issues':[{'id':'B1','severity':'P1','description':'Missing authorization','closed':False}]})\nc2=ns['Controller'](r,d);print(json.dumps(c2.review('c'*40)))`,"if sys.argv[1]=='run':\n a=json.loads(sys.argv[-2])\n if a[0]=='git':print('src/app.js')\n else:print(json.dumps({'verdict':'CLEAN','issues':[]}))\n");
 assert.equal(r.verdict,'BLOCKING');assert.equal(r.issues[0].id,'B1');
});
test('fresh target machine defers carried evidence recovery before any execution',t=>{
 const r=python(t,`r['task']['development'].update(generation=2,baseline='a'*40,reviewCarry={'issues':[],'evidenceRecoveryRequired':True})\nc2=ns['Controller'](r,d);c2.execute();receipt=json.loads(c2.record.read_text())\nprint(json.dumps({'stage':receipt['result']['development']['stage'],'error':receipt.get('error')}))`);
 assert.equal(r.stage,'DEFERRED');assert.match(r.error,/evidence.*recover/i);
});
test('coding containers mount exact frozen behavioral tests read-only while production stays writable',t=>{const r=python(t,`import hashlib\ntestfile=c.work/'sum.test.mjs';testfile.write_text('frozen behavior')\nc.state['red']={'files':[['sum.test.mjs',hashlib.sha256(b'frozen behavior').hexdigest()]]}\nargs=c.docker_args(protect_tests=True)\nprint(json.dumps({'args':args}))`);const mounts=r.args.filter((v,i,a)=>a[i-1]==='--mount');assert.ok(mounts.some(x=>x.endsWith('dst=/workspace/sum.test.mjs,readonly')));assert.ok(mounts.some(x=>x.endsWith('dst=/workspace')));});
test('post-sync independent review uses verified delivery baseline and retains original baseline',t=>{const r=python(t,`c.spec.update(baseline='a'*40,requirement='implement product');c.p['criteria']=[];c.state['deliveryBase']='b'*40\ncalls=[]\nc.git=lambda *args:(calls.append(list(args)) or 'product.mjs')\nc.agent=lambda *args:json.dumps({'verdict':'CLEAN','issues':[]})\nreview=c.review('c'*40)\nprint(json.dumps({'diff':calls[0],'original':c.spec['baseline'],'covered':review['covered']}))`);assert.deepEqual(r.diff,['diff','--name-only','b'.repeat(40),'c'.repeat(40)]);assert.equal(r.original,'a'.repeat(40));assert.equal(r.covered,true);});
test('resuming retained code does not replay a delivery input from a previous generation',t=>{const r=python(t,`c.g=2;c.spec['deliveryInput']={'generation':1,'baseSha':'b'*40,'previousSha':'a'*40,'repair':True}\nc.git=lambda *a:(_ for _ in ()).throw(ValueError('stale synchronization was replayed'))\nc.delivery_sync()\nprint(json.dumps({'skippedOldInput':True}))`);assert.equal(r.skippedOldInput,true);});
test('explicit retained-code verification resumes checks without claiming old blockers closed',t=>{const r=python(t,`c.spec['baseline']='a'*40\nprior={'stage':'DEFERRED','checkpointStage':'FIX','policyRevision':'p','manifest':{'baseline':'a'*40,'path':str(c.work)},'issueLedger':[{'id':'open','severity':'P1','closed':False}]}\nns['atomic'](d/'receipt-1.json',{'finished':True,'result':{'development':prior}})\nr['task']['development'].update(generation=2,verifyCurrent=True,baseline='a'*40)\nresumed=ns['Controller'](r,d)\nprint(json.dumps({'stage':resumed.resume_stage,'issues':resumed.state['issueLedger']}))`);assert.equal(r.stage,'TEST');assert.equal(r.issues[0].closed,false);});
test('independent review accepts one exact JSON fence inside a successful CLI envelope without weakening verdict checks',t=>{
 const r=python(t,`c.spec.update(baseline='a'*40,requirement='implement product');c.p['criteria']=[]\nc.git=lambda *args:'product.mjs'\nc.agent=lambda *args:json.dumps({'result':'\u0060\u0060\u0060json\\n'+json.dumps({'verdict':'CLEAN','issues':[]})+'\\n\u0060\u0060\u0060'})\nprint(json.dumps(c.review('c'*40)))`);assert.equal(r.verdict,'CLEAN');assert.equal(r.sha,'c'.repeat(40));
});
test('review JSON normalization rejects surrounding prose and multiple blocks',t=>{const r=python(t,`fence=chr(96)*3;results=[]\nfor text in ['prefix '+fence+'json\\n{}\\n'+fence,fence+'json\\n{}\\n'+fence+'\\n'+fence+'json\\n{}\\n'+fence]:\n try:ns['review_json'](text);results.append(True)\n except ValueError:results.append(False)\nprint(json.dumps(results))`);assert.deepEqual(r,[false,false]);});
