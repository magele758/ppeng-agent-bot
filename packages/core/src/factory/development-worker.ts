/** Fixed host controller. Repository code is only executed in an isolated container. */
export const DEVELOPMENT_WORKER=String.raw`
import os,sys,json,time,pathlib,subprocess,hashlib,fcntl,socket,socketserver,http.server,threading,urllib.request,urllib.error,re,selectors,stat,shutil,base64

def review_json(text):
    if not isinstance(text,str):raise ValueError("Review text required")
    text=text.strip();fence=chr(96)*3
    match=re.fullmatch(re.escape(fence)+r"(?:json)?[ \t]*\n([\s\S]*?)\n"+re.escape(fence),text)
    return json.loads(match.group(1) if match else text)
def identity():
    return hashlib.sha256(pathlib.Path('/etc/machine-id').read_bytes().strip()).hexdigest()
def process_token(pid):
    try:return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
    except (OSError,IndexError):return None
def alive(receipt):
    pid=receipt.get('pid');token=receipt.get('processToken')
    return isinstance(pid,int) and pid>0 and token is not None and process_token(pid)==token
def atomic(path,value):
    temp=path.with_name(path.name+'.'+str(os.getpid())+'.tmp')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:json.dump(value,f)
    os.replace(temp,path)
def safe_dir(path):
    if any(x.is_symlink() for x in [path,*path.parents]):raise ValueError('Unsafe factory directory')
    path.mkdir(parents=True,exist_ok=True,mode=0o700)
    if any(x.is_symlink() for x in [path,*path.parents]) or path.stat().st_uid!=os.getuid():raise ValueError('Unsafe factory directory')
    return path
ROOT=safe_dir(pathlib.Path.home()/'.local/state/ppeng-factory/development')
def read_json(p):
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd) as f:return json.load(f)
MAX_BUNDLE=700000
def read_bundle(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):raise ValueError('Regular artifact required')
        data=f.read(MAX_BUNDLE+1)
    if not data or len(data)>MAX_BUNDLE:raise ValueError('Artifact size limit exceeded')
    return data
def bundle_envelope(value,expected):
    if not isinstance(value,dict) or value.get('sha')!=expected or not re.fullmatch(r'[a-f0-9]{40,64}',str(expected)):raise ValueError('Dependency commit mismatch')
    if not re.fullmatch(r'[a-f0-9]{40,64}',str(value.get('baseline',''))):raise ValueError('Artifact baseline invalid')
    if not isinstance(value.get('base64'),str) or len(value['base64'])>MAX_BUNDLE*4//3+8:raise ValueError('Artifact size limit exceeded')
    data=base64.b64decode(value['base64'],validate=True)
    if not data or len(data)>MAX_BUNDLE or len(data)!=value.get('bytes') or hashlib.sha256(data).hexdigest()!=value.get('digest'):raise ValueError('Artifact integrity mismatch')
    if not data.startswith((b'# v2 git bundle\n',b'# v3 git bundle\n')):raise ValueError('Git bundle required')
    return data,{key:value[key] for key in ('sha','baseline','digest','bytes')}
def store_bundle(path,data):
    if path.exists():
        if read_bundle(path)!=data:raise ValueError('Immutable artifact conflict')
        return
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
    with os.fdopen(fd,'wb') as f:f.write(data)
def persisted_state(receipt,directory):
    state=receipt.get('result',{}).get('development',{})
    if not state.get('receiptOverflow'):return state
    meta=state.get('snapshot',{});name=meta.get('name','')
    try:
        if not re.fullmatch(r'state-[0-9]+-[0-9]+[.]json',name):raise ValueError('Invalid snapshot')
        fd=os.open(directory/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(fd,'rb') as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):raise ValueError('Regular snapshot required')
            data=f.read()
        if len(data)!=meta['bytes'] or hashlib.sha256(data).hexdigest()!=meta['digest']:raise ValueError('Snapshot integrity mismatch')
        return json.loads(data).get('result',{}).get('development',{})
    except Exception:return {**state,'evidenceRecoveryRequired':True}
def git_env():
    return {'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','LANG':'C.UTF-8'}
def host(args,timeout=15):
    return subprocess.check_output(args,env=git_env(),stderr=subprocess.DEVNULL,timeout=timeout,text=True).strip()
def credentials(policy):
    ref=policy['credentialRef']
    if ref=='claude-settings':
        value=read_json(pathlib.Path.home()/'.claude/settings.json').get('env',{})
        base=value.get('ANTHROPIC_BASE_URL','https://api.anthropic.com').rstrip('/')
        key=value.get('ANTHROPIC_AUTH_TOKEN') or value.get('ANTHROPIC_API_KEY')
    else:
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',ref):raise ValueError('Invalid credential reference')
        value=read_json(pathlib.Path.home()/'.config/ppeng-factory/credentials'/(ref+'.json'))
        base=value['baseUrl'].rstrip('/');key=value['apiKey']
    if not key or base!=policy['modelUrl'].rstrip('/'):raise ValueError('Credential endpoint mismatch')
    return key
def model_connection(policy):
    key=credentials(policy);base=policy['modelUrl'].rstrip('/')
    if base.endswith('/v1'):base=base[:-3]
    data=json.dumps({'model':policy['model'],'max_tokens':1,'messages':[{'role':'user','content':'ping'}]}).encode()
    request=urllib.request.Request(base+'/v1/messages',data=data,headers={'content-type':'application/json','anthropic-version':'2023-06-01','authorization':'Bearer '+key,'x-api-key':key},method='POST')
    with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect).open(request,timeout=10) as response:
        body=response.read(65537)
        if len(body)>65536 or not isinstance(json.loads(body),dict):raise ValueError('Invalid model probe')
        return 'selected model connection verified'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
class ModelBroker(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_CONNECT(self):self.send_error(403)
    def do_GET(self):self.send_error(403)
    def do_POST(self):
        self.connection.settimeout(10)
        if self.headers.get('transfer-encoding') or len(self.headers.get_all('content-length',[]))!=1:self.send_error(400);return
        if self.path not in ('/v1/messages','/v1/messages/count_tokens','/v1/messages?beta=true','/v1/messages/count_tokens?beta=true'):self.send_error(403);return
        try:
            size=int(self.headers.get('content-length','0'))
            if size<1 or size>1048576:raise ValueError('size')
            if not self.server.slots.acquire(False):self.send_error(429);return
            try:self.forward(size)
            finally:self.server.slots.release()
        except Exception:self.send_error(502,'Model request failed')
    def forward(self,size):
        if not self.server.active or self.server.calls>=200:self.send_error(429);return
        raw=self.rfile.read(size)
        if len(raw)!=size:raise ValueError('Incomplete request')
        body=json.loads(raw)
        if not isinstance(body,dict):raise ValueError('JSON object required')
        body['model']=self.server.policy['model']
        if 'max_tokens' in body:
            if not isinstance(body['max_tokens'],int) or isinstance(body['max_tokens'],bool) or body['max_tokens']<1:raise ValueError('Invalid token budget')
            body['max_tokens']=min(body['max_tokens'],8192)
        self.server.calls+=1
        base=self.server.policy['modelUrl'].rstrip('/')
        if base.endswith('/v1'):base=base[:-3]
        req=urllib.request.Request(base+self.path,data=json.dumps(body).encode(),headers={'content-type':'application/json','anthropic-version':'2023-06-01','authorization':'Bearer '+self.server.key,'x-api-key':self.server.key},method='POST')
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect)
        try:
            with opener.open(req,timeout=120) as response:
                data=response.read(10485761)
                if len(data)>10485760:raise ValueError('response too large')
                data=data.replace(self.server.key.encode(),b'[REDACTED:UPSTREAM_CREDENTIAL]')
                self.send_response(response.status);self.send_header('content-type',response.headers.get('content-type','application/json'));self.send_header('content-length',str(len(data)));self.end_headers();self.wfile.write(data)
        except urllib.error.HTTPError as e:self.send_error(e.code,'Upstream model request failed')
class UnixServer(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):daemon_threads=True
BRIDGE="""const http=require('node:http');const p=http.createServer((req,res)=>{const q=http.request({socketPath:'/broker/model.sock',path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});q.on('error',()=>{res.writeHead(502);res.end()});req.pipe(q)});p.listen(18491,'127.0.0.1');"""
EXPORT="""import os,sys,pathlib,subprocess,json,base64,hashlib
base,sha=sys.argv[1:3]
git=['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false']
if subprocess.check_output(git+['rev-parse','HEAD'],text=True).strip()!=sha:raise ValueError('Commit changed before artifact export')
path=pathlib.Path('/tmp/dependency.bundle')
subprocess.run(git+['bundle','create',str(path),base+'..HEAD'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if path.stat().st_size>700000:raise ValueError('Artifact exceeds export limit')
data=path.read_bytes()
print(json.dumps({'sha':sha,'baseline':base,'digest':hashlib.sha256(data).hexdigest(),'bytes':len(data),'base64':base64.b64encode(data).decode()}))"""
DIGEST="""import pathlib,hashlib,json,os,stat
root=pathlib.Path('/workspace'); rows=[]; protected=[]; total=0
for directory,dirs,files in os.walk(root,followlinks=False):
 dirs[:]=[x for x in dirs if x not in ('.git','node_modules','.cache')]
 for name in sorted(dirs+files):
  p=pathlib.Path(directory)/name;relative=p.relative_to(root)
  if p.is_symlink():raise ValueError('symlink refused')
  if not p.is_file():continue
  test=any('test' in x.lower() or 'spec' in x.lower() for x in relative.parts)
  policy=name in ('package.json','package-lock.json','pnpm-lock.yaml','yarn.lock','pyproject.toml','poetry.lock','requirements.txt','Cargo.toml','Cargo.lock','Makefile')
  if not test and not policy:continue
  if p.stat().st_size>1048576:raise ValueError('evidence file too large')
  total+=p.stat().st_size
  if total>8388608 or len(rows)+len(protected)>10000:raise ValueError('evidence tree too large')
  item=(str(relative),hashlib.sha256(p.read_bytes()).hexdigest())
  if test:rows.append(item)
  if policy:protected.append(item)
rows.sort();protected.sort()
print(json.dumps({'files':rows,'digest':hashlib.sha256(json.dumps(rows).encode()).hexdigest(),'protected':hashlib.sha256(json.dumps(protected).encode()).hexdigest()}))"""
class ReceiptOverflow(Exception):pass
class TerminationUnknown(Exception):pass
class StopRun(Exception):pass
class Deferred(Exception):pass
class Controller:
    def __init__(self,req,directory):
        self.req=req;self.task=req['task'];self.d=directory;self.spec=self.task['development'];self.p=self.spec['policy'];self.g=self.spec['generation'];self.name=self.task['id']+'_'+str(self.g);self.record=self.d/('receipt-'+str(self.g)+'.json');self.seq=1;self.deadline=time.monotonic()+self.p['timeoutMs']/1000;self.round=self.spec.get('round',0);self.logs=[];self.broker=None;self.container=None;self.artifacts={};self.cancel=None;self.next_storage_check=0;self.command_index=0
        self.work=self.d/'work';self.input=safe_dir(self.d/('input-'+str(self.g)));self.broker_dir=safe_dir(safe_dir(pathlib.Path('/tmp').resolve()/('ppeng-factory-'+str(os.getuid())))/hashlib.sha256((self.task['id']+':'+str(self.g)).encode()).hexdigest()[:32])
        self.state={'generation':self.g,'stage':'START','round':self.round,'policyRevision':self.p['revision'],'delivery':'not_pushed'}
        self.resume_stage=None
        if any(execution.get('result',{}).get('development',{}).get('receiptOverflow') or execution.get('result',{}).get('development',{}).get('evidenceRecoveryRequired') for execution in self.spec.get('executions',[])):self.state['evidenceRecoveryRequired']=True
        previous=self.d/('receipt-'+str(self.g-1)+'.json')
        if self.g>1 and previous.exists():
            receipt=read_json(previous);prior=persisted_state(receipt,self.d)
            if receipt.get('result',{}).get('development',{}).get('receiptOverflow') or prior.get('evidenceRecoveryRequired'):self.state['evidenceRecoveryRequired']=True
            if not receipt.get('finished'):raise TerminationUnknown('Previous execution termination unconfirmed')
            if prior.get('policyRevision')==self.p['revision'] and prior.get('manifest',{}).get('baseline')==self.spec['baseline']:
                saved=pathlib.Path(prior.get('manifest',{}).get('path',str(self.work)))
                match=re.fullmatch(r'work(?:-([1-9][0-9]*))?',saved.name)
                if saved.parent!=self.d or not match or (match.group(1) and int(match.group(1))>=self.g):raise ValueError('Invalid saved task workspace')
                if any(part.is_symlink() for part in (saved,*saved.parents)) or not saved.is_dir() or saved.stat().st_uid!=os.getuid():raise ValueError('Unsafe or missing saved task workspace')
                self.work=saved
                self.state.update(prior);self.state.update(generation=self.g,stage='START',delivery='not_pushed')
                self.round=max(self.round,prior.get('round',0));self.resume_stage=prior.get('stage')
                if self.resume_stage in ('PAUSED','DEFERRED','FAILED','TIMED_OUT','CANCELLED'):self.resume_stage=prior.get('checkpointStage')
                self.artifacts=prior.get('artifacts',{});self.logs=[prior.get('log','')]
            elif self.work.exists():self.work=self.d/('work-'+str(self.g))
        if self.spec.get('verifyCurrent'):self.resume_stage='TEST'
    def output_evidence(self,out,err,private):
        if private:return
        self.command_index+=1
        for stream,data in (('stdout',out),('stderr',err)):
            text=bytes(data).decode('utf-8','replace')
            if self.broker and getattr(self.broker,'key',None):text=text.replace(self.broker.key,'[REDACTED:UPSTREAM_CREDENTIAL]')
            raw=text.encode();tail=raw[-65536:]
            name='command-'+str(self.g)+'-'+str(self.command_index)+'-'+stream+'.txt'
            fd=os.open(self.d/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as f:f.write(tail);f.flush();os.fsync(f.fileno())
            self.artifacts[name]={'kind':'command-output','name':name,'generation':self.g,'round':self.round,'stage':self.state.get('stage'),'sha':self.state.get('sha'),'policyRevision':self.p['revision'],'stream':stream,'bytes':len(tail),'totalBytes':len(raw),'outputTruncated':len(raw)>65536,'digest':hashlib.sha256(tail).hexdigest()}
    def journal(self,stage):
        event={'stage':stage,'generation':self.g,'round':self.round,'sha':self.state.get('sha'),'policyRevision':self.p['revision'],'seq':self.seq,'at':time.time()}
        if self.state.get('checks'):event['checks']=[{key:row.get(key) for key in ('id','round','sha','exitCode','passed','executed','skipped','outputTruncated','evidence')} for row in self.state['checks']]
        review=self.state.get('review')
        if review:
            event['review']={key:review.get(key) for key in ('round','sha','verdict','covered','policyRevision')}
            event['review'].update(segments=[{'sha':segment.get('sha'),'verdict':segment.get('verdict'),'files':len(segment.get('files',[])),'policyRevision':segment.get('policyRevision')} for segment in review.get('segments',[])],issues=[{'id':str(issue.get('id',''))[:80],'severity':issue.get('severity'),'closed':issue.get('closed',False),'description':str(issue.get('description',''))[:160]} for issue in review.get('issues',[])[:20]],issueCount=len(review.get('issues',[])))
        name='events-'+str(self.g)+'.jsonl';path=self.d/name
        fd=os.open(path,os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'ab') as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):raise ValueError('Regular journal required')
            f.write((json.dumps(event,ensure_ascii=False)+'\n').encode());f.flush();os.fsync(f.fileno())
        digest=hashlib.sha256();size=0;fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd,'rb') as f:
            while True:
                part=f.read(65536)
                if not part:break
                size+=len(part);digest.update(part)
        self.artifacts[name]={'kind':'stage-journal','name':name,'generation':self.g,'bytes':size,'digest':digest.hexdigest(),'complete':True}
        timeline=self.state.setdefault('timeline',[]);timeline.append(event)
        while len(timeline)>256 or len(json.dumps(timeline).encode())>262144:
            timeline.pop(0);self.state['timelineTruncated']=True
        self.state.setdefault('timelineTruncated',False)
    def bound_artifacts(self):
        required={'events-'+str(self.g)+'.jsonl'}
        for row in self.state.get('checks',[]):required.update(row.get('evidence',{}).values())
        required.update(self.state.get('red',{}).get('evidence',{}).values())
        kept={key:value for key,value in self.artifacts.items() if key in required}
        if len(json.dumps(kept).encode())>262144:raise Deferred('Required evidence metadata exceeds limit')
        size=len(json.dumps(kept).encode())
        for key,value in reversed(list(self.artifacts.items())):
            if key in kept:continue
            length=len(json.dumps({key:value}).encode())
            if len(kept)<512 and size+length<=262144:kept[key]=value;size+=length
        if len(kept)!=len(self.artifacts):self.state['artifactsTruncated']=True
        self.state.setdefault('artifactsTruncated',False);self.artifacts=kept;self.state['artifacts']=kept
    def save(self,stage,status='running',finished=False,error=None):
        self.seq+=1;self.state.update(stage=stage,round=self.round,artifacts=self.artifacts)
        if stage in ('RED','DEV','TEST','REVIEW','FIX'):self.state['checkpointStage']=stage
        self.journal(stage)
        self.bound_artifacts()
        self.state['log']='\n'.join(self.logs)[-32768:]
        self.state['logTruncated']=len('\n'.join(self.logs))>32768
        r={'status':status,'seq':self.seq,'identity':identity(),'finished':finished,'pid':os.getpid(),'processToken':process_token(os.getpid()),'at':time.time(),'result':{'development':self.state}}
        if error:r['error']=error
        if len(json.dumps(r).encode())>1572864:
            name='state-'+str(self.g)+'-'+str(self.seq)+'.json';snapshot=self.d/name
            meta={'kind':'receipt-snapshot','name':name,'available':False}
            try:
                atomic(snapshot,r);fd=os.open(snapshot,os.O_RDONLY|os.O_NOFOLLOW)
                with os.fdopen(fd,'rb') as f:data=f.read()
                meta.update(available=True,bytes=len(data),digest=hashlib.sha256(data).hexdigest())
            except OSError as failure:meta['error']='Snapshot write failed errno='+str(failure.errno)
            uncertain=self.container is not None or (status=='unknown' and not finished)
            compact={'generation':self.g,'stage':'VERIFYING' if uncertain else 'DEFERRED','round':self.round,'policyRevision':self.p['revision'],'delivery':'not_pushed','receiptOverflow':True,'snapshot':meta,'timelineTruncated':True,'artifactsTruncated':True,'sha':self.state.get('sha')}
            r.update(status='unknown' if uncertain else 'failed',finished=not uncertain,error='Receipt exceeds publication limit; full evidence retained in private snapshot' if meta['available'] else 'Receipt exceeds publication limit; full snapshot unavailable; manual evidence recovery required',result={'development':compact})
            atomic(self.record,r)
            raise ReceiptOverflow('Oversized receipt deferred; no new stages may start')
        atomic(self.record,r)
    def storage_check(self):
        if time.monotonic()<self.next_storage_check:return
        self.next_storage_check=time.monotonic()+1
        if shutil.disk_usage(ROOT).free<self.p.get('minDiskMb',128)*1048576:raise Deferred('Host free-space reserve reached')
        total=0;count=0
        if not self.work.exists():return
        for _,dirs,files,fd in os.fwalk(self.work,follow_symlinks=False):
            for name in files:
                item=os.stat(name,dir_fd=fd,follow_symlinks=False);count+=1
                if stat.S_ISREG(item.st_mode):total+=item.st_size
                if total>self.p.get('maxWorkspaceMiB',1024)*1048576 or count>200000:raise Deferred('Task workspace storage limit reached')
    def stopping(self):
        control=self.d/('control-'+str(self.g)+'.json')
        if control.exists():self.cancel=read_json(control)['action'];raise StopRun('Requested '+self.cancel)
        if time.monotonic()>self.deadline:self.cancel='timeout';raise StopRun('Task deadline exceeded')
        self.storage_check()
    def run_host(self,args):
        self.stopping();return host(args, min(30,max(1,self.deadline-time.monotonic())))
    def docker_args(self,readonly=False,protect_tests=False):
        args=['docker','run','--name',self.name,'--network','none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit','128','--memory','2g','--cpus','2','--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,nosuid,nodev,size=128m']
        for source,dest,ro in [(self.work,'/workspace',readonly),(self.input,'/input',True),(self.broker_dir,'/broker',True),(pathlib.Path(self.p['toolPath']),'/tools/claude',True)]:args+=['--mount','type=bind,src='+str(source)+',dst='+dest+(',readonly' if ro else '')]
        if protect_tests and self.state.get('red'):
            files=self.state.get('deliveryFrozenFiles',self.state['red'].get('files',[]))
            if len(files)>256:raise Deferred('Frozen test mount budget exceeded')
            frozen=safe_dir(self.input/'frozen-tests')
            for index,(name,digest) in enumerate(files):
                relative=pathlib.PurePosixPath(name)
                if relative.is_absolute() or '..' in relative.parts:raise Deferred('Invalid frozen test path')
                path=self.work/name
                if any(p.is_symlink() for p in [path,*path.parents]):raise Deferred('Unsafe frozen test path')
                fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                with os.fdopen(fd,'rb') as f:
                    if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):raise Deferred('Regular frozen test required')
                    data=f.read(1048577)
                if len(data)>1048576 or hashlib.sha256(data).hexdigest()!=digest:raise Deferred('Frozen behavioral tests were modified')
                target=frozen/str(index)
                if not target.exists():
                    fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
                    with os.fdopen(fd,'wb') as f:f.write(data)
                elif target.is_symlink() or hashlib.sha256(target.read_bytes()).hexdigest()!=digest:raise Deferred('Frozen test snapshot integrity mismatch')
                args+=['--mount','type=bind,src='+str(target)+',dst=/workspace/'+name+',readonly']
        args+=['--workdir','/workspace','--env','HOME=/tmp/home','--env','GIT_CONFIG_GLOBAL=/dev/null','--env','GIT_CONFIG_NOSYSTEM=1','--env','GIT_TERMINAL_PROMPT=0','--env','ANTHROPIC_AUTH_TOKEN=broker-only','--env','ANTHROPIC_BASE_URL=http://127.0.0.1:18491','--env','ANTHROPIC_MODEL='+self.p['model'],'--env','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1','--env','DISABLE_AUTOUPDATER=1',self.p['image']]
        return args
    def command(self,argv,readonly=False,model=False,private=False):
        self.stopping()
        if self.broker:self.broker.active=model
        # The wrapper is controller-owned and mounted read-only; no shell interpolation.
        wrapper=['node','/input/run.cjs',json.dumps(argv), 'model' if model else 'plain']
        child=subprocess.Popen(self.docker_args(readonly,protect_tests=model and not readonly)+wrapper,env=git_env(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        self.container=self.name;out=bytearray();err=bytearray();self.last_stderr='';sel=selectors.DefaultSelector();sel.register(child.stdout,selectors.EVENT_READ,'stdout');sel.register(child.stderr,selectors.EVENT_READ,'stderr')
        try:
            while sel.get_map():
                self.stopping()
                for key,_ in sel.select(.2):
                    chunk=os.read(key.fd,8192)
                    if not chunk:sel.unregister(key.fileobj)
                    elif key.data=='stdout':out.extend(chunk)
                    else:err.extend(chunk)
                if len(out)+len(err)>1048576:raise Deferred('Output exceeded evidence limit')
            code=child.wait(timeout=5);value=out.decode('utf-8','replace');diagnostic=err.decode('utf-8','replace');self.last_stderr=diagnostic[-8192:]
            if not model and diagnostic:value+='\n'+diagnostic
            if not private:
                self.logs.append(value[-8192:])
                if model and diagnostic:self.logs.append('[stderr]\n'+diagnostic[-8192:])
            return code,value
        finally:
            sel.close()
            evidence_error=None
            try:self.output_evidence(out,err,private)
            except Exception as error:evidence_error=error
            if self.broker:self.broker.active=False
            confirmed=False
            try:host(['docker','rm','-f',self.name],10);confirmed=True
            except Exception:
                try:confirmed=host(['docker','inspect','--format','{{.State.Running}}',self.name],5)=='false'
                except Exception:pass
            try:child.wait(timeout=5)
            except Exception:child.kill();child.wait(timeout=5)
            if not confirmed:raise TerminationUnknown('Container termination not confirmed; retain capacity')
            self.container=None
            if evidence_error:raise Deferred('Command evidence could not be persisted')
    def checked(self,argv,readonly=False):
        code,out=self.command(argv,readonly)
        if code:raise Deferred('Trusted operation failed: '+str(argv[0]))
        return out.strip()
    def git(self,*args):return self.checked(['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.pager=cat',*args])
    def setup(self):
        self.input.joinpath('bridge.cjs').write_text(BRIDGE)
        self.input.joinpath('digest.py').write_text(DIGEST)
        self.input.joinpath('export.py').write_text(EXPORT)
        self.input.joinpath('run.cjs').write_text("const{spawn}=require('node:child_process');const fs=require('node:fs');fs.mkdirSync('/tmp/home',{recursive:true});if(process.argv[3]==='model')require('/input/bridge.cjs');const a=JSON.parse(process.argv[2]);const p=spawn(a[0],a.slice(1),{stdio:'inherit'});p.on('error',()=>process.exit(127));p.on('exit',c=>process.exit(c??1));")
        source_sha=self.run_host(['git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',self.task['repositoryPath'],'rev-parse','HEAD'])
        if not self.work.exists():
            self.work.mkdir(mode=0o700)
            # Bundle creation reads the source before any repository code is executed.
            bundle=self.input/'source.bundle'
            self.run_host(['git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',self.task['repositoryPath'],'bundle','create',str(bundle),'--all'])
            self.checked(['git','clone','--no-hardlinks','/input/source.bundle','/workspace'])
            self.git('checkout','-b','codex/'+self.task['id'],self.spec['baseline'])
            self.git('config','user.name','Factory');self.git('config','user.email','factory@localhost')
        elif self.work.is_symlink():raise ValueError('Unsafe workspace')
        self.state['manifest']={'baseline':self.spec['baseline'],'path':str(self.work),'sourcePath':self.task['repositoryPath'],'independentGit':True,'sourceBefore':source_sha,'sourceAfter':source_sha}
        dependency=self.spec.get('dependency')
        if dependency:
            prepared=self.d/('dependency-'+str(self.g)+'.bundle');manifest=read_json(self.d/('dependency-'+str(self.g)+'.json'))
            data=read_bundle(prepared)
            if manifest.get('sha')!=dependency['sha'] or manifest.get('bytes')!=len(data) or manifest.get('digest')!=hashlib.sha256(data).hexdigest():raise Deferred('Dependency artifact unavailable or invalid')
            store_bundle(self.input/'dependency.bundle',data)
            self.git('bundle','verify','/input/dependency.bundle')
            self.git('fetch','--no-tags','/input/dependency.bundle','HEAD')
            if self.git('rev-parse','FETCH_HEAD')!=dependency['sha']:raise Deferred('Dependency artifact commit mismatch')
            self.state['dependencyArtifact']=manifest
        code,_=self.command(self.p['install']);self.state['dependencies']={'exitCode':code,'isolated':True}
        if code:raise Deferred('Dependency installation failed')
        key=credentials(self.p);sock=self.broker_dir/'model.sock'
        if sock.exists():sock.unlink()
        self.broker=UnixServer(str(sock),ModelBroker);os.chmod(sock,0o600)
        self.broker.policy=self.p;self.broker.key=key;self.broker.slots=threading.BoundedSemaphore(2);self.broker.calls=0;self.broker.active=False
        threading.Thread(target=self.broker.serve_forever,daemon=True).start()
    def agent(self,prompt,review=False):
        if not review:prompt='The trusted controller runs all tests and creates Git commits AFTER this tool exits. During RED edit only tests. In DEV/FIX edit production files only: all existing tests are immutable read-only mounts, including any coverage gaps mentioned by reviewers. If the saved production fix is already present, finish immediately with DONE. Make one bounded pass over the requested files and finish. Do not run tests, poll Bash/background tasks, make Git commits, or wait for controller stages inside this tool. '+prompt
        if self.spec.get('dependency'):prompt+='\nVerified dependency artifact: /input/dependency.bundle at commit '+self.spec['dependency']['sha']+'. Baseline HEAD stays as requested. Use the exact verified artifact as required.'
        args=list(self.p['reviewArgv'] if review else self.p['codeArgv'])+['--model',self.p['model'],prompt]
        for attempt in range(self.p['maxRetries']+1):
            code,out=self.command(args,readonly=review,model=True)
            protocol_error=False
            if code==0:
                try:
                    value=json.loads(out)
                    if isinstance(value,dict) and (value.get('type')=='result' or 'result' in value or 'is_error' in value or 'subtype' in value):protocol_error=value.get('is_error') is not False or ('subtype' in value and value['subtype']!='success')
                except (ValueError,TypeError):pass
                if not protocol_error:return out
            self.state['toolFailure']={'stage':self.state.get('stage','START'),'attempt':attempt+1,'exitCode':code,'protocolError':protocol_error,'output':out[-8192:],'stderr':getattr(self,'last_stderr',''),'at':time.time(),'nextAction':'retry' if attempt<self.p['maxRetries'] else 'defer'}
            self.save(self.state.get('stage','START'))
        raise Deferred('Coding or review tool unavailable; retry budget exhausted')
    def digest(self):return json.loads(self.checked(['python3','/input/digest.py']))
    def checks(self,sha):
        rows=[]
        for check in self.p['checks']:
            code,out=self.command(check['argv'])
            failed=re.findall(r'(?:not ok \d+ - |FAIL\s+)([^\n]+)',out)
            fresh=[x for x in failed if x not in self.p['baselineFailures']]
            skipped=bool(re.search(r'(?im)(?:^[ \t]*(?:not[ \t]+)?ok\b[^\n]*#[ \t]*(?:SKIP|TODO)\b|^[ \t]*#[ \t]*(?:skipped|todo)[ \t]+[1-9]\d*\b|\b(?:skipped|pending)[ \t]*[:=][ \t]*[1-9]\d*\b|\b[1-9]\d*[ \t]+(?:skipped|pending)\b)',out))
            empty_tests=bool(re.search(r'(?im)^#\s*tests\s+0\b|No test files found',out))
            passed=(code==0 or bool(failed and not fresh)) and not skipped and not empty_tests
            rows.append({'id':check['id'],'round':self.round,'sha':sha,'passed':passed,'skipped':skipped,'exitCode':code,'failures':failed,'newFailures':fresh,'evidence':{'stdout':'command-'+str(self.g)+'-'+str(self.command_index)+'-stdout.txt','stderr':'command-'+str(self.g)+'-'+str(self.command_index)+'-stderr.txt'},'executed':True,'outputEmpty':not bool(out.strip()),'outputTruncated':len(out)>32768,'output':out[-32768:] if out.strip() else '(no output; exited '+str(code)+')'})
        return rows
    def red(self):
        self.save('RED')
        prompt='Write ONLY behavioral regression tests for these approved criteria. Do not implement or change production code, dependency definitions, checks or skip tests. Tests must include literal criterion IDs in titles. Independently verify expected values with exact arithmetic or other reliable oracles; do not invent numeric constants. Only write the regression tests and finish; the controller will execute them after you exit. Requirement: '+self.spec['requirement']+'\nApproved criteria: '+json.dumps(self.p['criteria'])
        before=self.digest()
        self.agent(prompt)
        # Test identity freezes after red and cannot be changed in implementation/fix.
        digest=self.digest()
        if digest['protected']!=before['protected']:raise Deferred('Dependency or gate definitions changed during red')
        changes=self.git('diff','--name-only',self.spec['baseline']).splitlines()
        if any(not any('test' in part.lower() or 'spec' in part.lower() for part in pathlib.PurePosixPath(name).parts) for name in changes):raise Deferred('Production code changed before behavioral red test')
        self.state['protectedDigest']=digest['protected']
        check=next(c for c in self.p['checks'] if c['id']==self.p['redCheck'])
        code,out=self.command(check['argv'])
        assertion=bool(re.search(r'ERR_ASSERTION|AssertionError|AssertionError|Expected values|expected.*(?:equal|true|false)',out,re.I))
        ids=[c['id'] for c in self.p['criteria'] if re.search(r'(?<![A-Za-z0-9_-])'+re.escape(c['id'])+r'(?![A-Za-z0-9_-])',out)]
        self.state['redAttempt']={'exitCode':code,'reason':'assertion' if assertion else 'environment','criteria':ids,'testDigest':digest['digest'],'files':digest['files'],'evidence':{'stdout':'command-'+str(self.g)+'-'+str(self.command_index)+'-stdout.txt','stderr':'command-'+str(self.g)+'-'+str(self.command_index)+'-stderr.txt'},'outputTruncated':len(out)>32768,'output':out[-32768:]}
        if code==0 or not assertion or len(ids)!=len(self.p['criteria']):raise Deferred('Behavioral red test evidence missing or environment failure')
        self.state['red']=self.state['redAttempt']
    def commit(self):
        self.git('add','--all');self.git('commit','--allow-empty','-m','Factory task '+self.task['id']+' round '+str(self.round));return self.git('rev-parse','HEAD')
    def review(self,sha):
        review_base=self.state.get('deliveryBase',self.spec['baseline'])
        files=self.git('diff','--name-only',review_base,sha).splitlines()
        if not files:raise Deferred('No task diff to review')
        prior=list(self.spec.get('reviewCarry',{}).get('issues',[]))+list(self.state.get('issueLedger',self.state.get('review',{}).get('issues',[])));ledger={}
        if not prior:
            for execution in reversed(self.spec.get('executions',[])):
                old=execution.get('result',{}).get('development',{})
                if old.get('receiptOverflow'):
                    old=persisted_state({'result':{'development':old}},self.d)
                    if old.get('evidenceRecoveryRequired'):raise Deferred('Full prior evidence must be recovered before review')
                prior=old.get('issueLedger',old.get('review',{}).get('issues',[]))
                if prior:break
        if not prior:
            for generation in range(self.g-1,0,-1):
                previous=self.d/('receipt-'+str(generation)+'.json')
                if previous.exists():
                    old=persisted_state(read_json(previous),self.d)
                    if old.get('evidenceRecoveryRequired'):raise Deferred('Full prior evidence must be recovered before review')
                    prior=old.get('issueLedger',old.get('review',{}).get('issues',[]))
                    if prior:break
        for item in prior:
            entry=dict(item);key=entry.get('id') or 'legacy-'+hashlib.sha256(json.dumps(entry,sort_keys=True).encode()).hexdigest()[:16];entry['id']=key
            if entry.get('closed') and entry.get('evidenceSha')!=sha:entry['closed']=False;entry['revalidationRequired']=True
            known=ledger.get(key)
            if known:
                entry['description']=known.get('description',entry.get('description'))
                if {'P0':0,'P1':1,'P2':2}.get(known.get('severity'),0)<{'P0':0,'P1':1,'P2':2}.get(entry.get('severity'),0):entry['severity']=known['severity']
            ledger[key]=entry
        issues=[];segments=[];decisions={}
        # Controller assigns every changed file, including tests and configuration.
        for index in range(0,len(files),10):
            segment=files[index:index+10]
            prompt='Read-only independent vertical-slice review. Review full requirement, approved criteria and these changed files against verified current baseline '+review_base+' (original baseline '+self.spec['baseline']+') at commit '+sha+'. Read full content and follow connected call paths. Files: '+json.dumps(segment)+'\nRequirement: '+self.spec['requirement']+'\nCriteria: '+json.dumps(self.p['criteria'])+'\nReturn ONLY JSON {"verdict":"CLEAN"|"BLOCKING","issues":[{"id":"...","severity":"P0"|"P1"|"P2","description":"...","closed":false}]}. Missing coverage, unsafe bypass, weakened tests, dead code, incomplete behavior or a gate failure is blocking.'
            prompt+='\nEvaluate regression coverage across the repository, including immutable assertions in CI workflows. A genuine existing CI regression for the exact case is coverage; do not demand duplicate coverage in a frozen local test file. Verify imports (node:assert/strict differs from loose node:assert), execute the existing checks where possible, and close a proven coverage false positive explicitly with its original ID, reason, evidence and current SHA. Missing actual coverage or failing behavior remains blocking. Never close an issue just because tests are frozen.'
            prompt+='\nKnown issue ledger (must retain IDs): '+json.dumps(list(ledger.values()))+'\nExplicitly verify every known issue. Omitted issues remain open. Closing requires the same id/severity/description, closed:true, nonempty reason, nonempty evidence describing validation, and evidenceSha equal to '+sha+'. CLEAN alone or a severity downgrade cannot close a blocker. Retain P2 issues.'
            out=self.agent(prompt,True)
            try:
                value=review_json(out)
                if isinstance(value,dict) and 'result' in value:value=review_json(value['result'])
                if not isinstance(value,dict) or value.get('verdict') not in ('CLEAN','BLOCKING') or not isinstance(value.get('issues'),list):raise ValueError('verdict')
                if value['verdict']=='BLOCKING' and not value['issues']:raise ValueError('issues')
                if any(not isinstance(x,dict) or x.get('severity') not in ('P0','P1','P2') or not isinstance(x.get('description'),str) or not x['description'].strip() or not isinstance(x.get('id'),str) or not x['id'].strip() or len(x['id'])>160 for x in value['issues']):raise ValueError('issues')
                if len({x['id'] for x in value['issues']})!=len(value['issues']):raise ValueError('Duplicate issue IDs')
            except Exception:raise Deferred('Invalid or missing independent review verdict')
            for reported in value['issues']:
                key=reported['id'];old=ledger.get(key);entry=dict(old or reported)
                if old:
                    entry['reviewDescription']=reported['description']
                    if {'P0':0,'P1':1,'P2':2}[reported['severity']]<{'P0':0,'P1':1,'P2':2}[old['severity']]:entry['severity']=reported['severity']
                proof=reported.get('closed') is True and all(isinstance(reported.get(field),str) and reported[field].strip() for field in ('reason','evidence')) and reported.get('evidenceSha')==sha
                decisions[key]=decisions.get(key,True) and proof
                entry['closed']=decisions[key];entry['lastReviewedSha']=sha;entry.setdefault('firstSeenSha',sha)
                if entry['closed']:
                    entry.update(reason=reported['reason'],evidence=reported['evidence'],evidenceSha=sha,revalidationRequired=False)
                else:
                    entry['closureRejected']=reported.get('closed') is True
                ledger[key]=entry
            self.state['issueLedger']=list(ledger.values());segments.append({'files':segment,'sha':sha,'verdict':value['verdict'],'policyRevision':self.p['revision']})
        issues=list(ledger.values())
        clean=all(x['verdict']=='CLEAN' for x in segments) and not any(x['severity'] in ('P0','P1') and not x.get('closed',False) for x in issues)
        return {'round':self.round,'files':files,'sha':sha,'covered':set(files)==set(f for x in segments for f in x['files']),'verdict':'CLEAN' if clean else 'BLOCKING','issues':issues,'segments':segments,'policyRevision':self.p['revision']}
    def export_artifact(self,sha):
        code,out=self.command(['python3','/input/export.py',self.spec['baseline'],sha],readonly=True,private=True)
        if code:raise Deferred('Artifact export unavailable or exceeds size limit')
        try:data,metadata=bundle_envelope(json.loads(out),sha)
        except Exception:raise Deferred('Artifact export integrity invalid')
        store_bundle(self.d/('artifact-'+str(self.g)+'.bundle'),data);self.state['artifact']=metadata
    def delivery_sync(self):
        delivery=self.spec.get('deliveryInput')
        if not delivery or delivery.get('generation',self.g)!=self.g:return
        base=delivery.get('baseSha','')
        if not re.fullmatch(r'[a-f0-9]{40}',base) or self.git('rev-parse','HEAD')!=delivery.get('previousSha'):raise Deferred('Delivery candidate changed before synchronization')
        if base!=self.state.get('deliveryBase',self.spec['baseline']):
            artifact=self.d/('delivery-'+base+'.bundle');meta=read_json(self.d/('delivery-'+base+'.json'));data=read_bundle(artifact)
            if meta.get('baseSha')!=base or meta.get('bytes')!=len(data) or meta.get('digest')!=hashlib.sha256(data).hexdigest():raise Deferred('Target bundle integrity mismatch')
            store_bundle(self.input/'delivery.bundle',data)
            self.git('bundle','verify','/input/delivery.bundle');self.git('fetch','--no-tags','/input/delivery.bundle','refs/factory/base')
            if self.git('rev-parse','FETCH_HEAD')!=base:raise Deferred('Target bundle commit mismatch')
            self.save('TEST')
            code,out=self.command(['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','merge','--no-edit',base])
            self.state.setdefault('deliverySyncs',[]).append({'baseSha':base,'exitCode':code,'output':out[-8192:]})
            if code:raise Deferred('Merge conflict retained in original isolated workspace; explicit decision required')
        self.state['deliveryBase']=base
        digest=self.digest()
        # Retain every original frozen test byte. Additional tests from the verified target
        # are also run, but cannot replace the original red test identity.
        current=dict(digest['files']);original=dict(self.state['red']['files'])
        if any(current.get(name)!=value for name,value in original.items()) or digest['protected']!=self.state['protectedDigest']:raise Deferred('Target changed frozen tests or gates; explicit policy confirmation required')
        self.state['deliveryTestDigest']=digest['digest'];self.state['deliveryFrozenFiles']=digest['files']
        self.resume_stage='TEST'
        if delivery.get('repair'):
            self.save('FIX');self.agent('Repair the actual trusted remote CI failure within the original requirement. Do not change tests, checks or automation. CI evidence: '+json.dumps(delivery.get('ci'))+'\nRequirement: '+self.spec['requirement'])
    def run(self):
        if self.state.get('evidenceRecoveryRequired') or self.spec.get('reviewCarry',{}).get('evidenceRecoveryRequired'):raise Deferred('Full prior evidence must be recovered before resume')
        self.save('START');self.setup()
        self.delivery_sync()
        if 'red' not in self.state:self.red()
        current=self.digest()
        if current['digest']!=self.state.get('deliveryTestDigest',self.state['red']['testDigest']) or current['protected']!=self.state['protectedDigest']:raise Deferred('Frozen tests or gate definitions changed before resume')
        if self.resume_stage in ('WAITING_DECISION','FIX'):
            if self.resume_stage=='WAITING_DECISION':self.round+=1
            if self.round>self.p['maxRounds']:raise Deferred('Repair rounds require explicit approval')
            self.save('FIX');self.agent('Repair the saved blocking evidence without changing frozen tests or gates. Requirement: '+self.spec['requirement']+'\nChecks: '+json.dumps(self.state.get('checks',[]))+'\nReview: '+json.dumps(self.state.get('review',{})))
        elif self.resume_stage not in ('TEST','REVIEW'):
            self.save('DEV');self.agent('Implement the requirement using the frozen failing tests. Only edit production code and finish; the controller will test, review and commit after you exit. Do not modify tests, dependency definitions or gate commands. Requirement: '+self.spec['requirement']+'\nCriteria: '+json.dumps(self.p['criteria']))
        while True:
            self.stopping();current=self.digest();self.state['greenTestDigest']=self.state['red']['testDigest'] if self.spec.get('deliveryInput') and current['digest']==self.state.get('deliveryTestDigest') else current['digest']
            if current['protected']!=self.state['protectedDigest']:raise Deferred('Dependency or gate definitions were modified')
            if self.state['greenTestDigest']!=self.state['red']['testDigest']:raise Deferred('Frozen behavioral tests were modified')
            sha=self.commit();self.state['sha']=sha;self.save('TEST');self.state['checks']=self.checks(sha)
            passing=all(r['passed'] for r in self.state['checks'] if next(c for c in self.p['checks'] if c['id']==r['id'])['required'])
            if passing:
                self.save('REVIEW');self.state['review']=self.review(sha)
                if self.state['review']['verdict']=='CLEAN':
                    self.state['manifest']['sourceAfter']=self.run_host(['git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',self.task['repositoryPath'],'rev-parse','HEAD'])
                    if self.state['manifest']['sourceAfter']!=self.state['manifest']['sourceBefore']:raise Deferred('Original checkout changed during execution')
                    self.state['clean']=not bool(self.git('status','--porcelain'))
                    if not self.state['clean'] or self.git('rev-parse','HEAD')!=sha:raise Deferred('Workspace changed after checks')
                    self.export_artifact(sha)
                    self.save('READY','succeeded',True);return
            if self.round>=self.p['maxRounds']:self.save('WAITING_DECISION','failed',True,'Repair rounds exhausted');return
            self.round+=1;self.save('FIX')
            self.agent('Repair the reported blocking issues. Do not alter frozen tests or weaken checks. Requirement: '+self.spec['requirement']+'\nChecks: '+json.dumps(self.state.get('checks',[]))+'\nReview: '+json.dumps(self.state.get('review',{})))
    def execute(self):
        try:self.run()
        except ReceiptOverflow:pass
        except TerminationUnknown as e:self.save('VERIFYING','unknown',False,str(e))
        except StopRun as e:
            stage={'pause':'PAUSED','cancel':'CANCELLED','timeout':'TIMED_OUT'}.get(self.cancel,'FAILED')
            self.save(stage,'cancelled' if self.cancel=='cancel' else 'timed_out' if self.cancel=='timeout' else 'failed',True,str(e))
        except Deferred as e:self.save('DEFERRED','failed',True,str(e))
        except OSError as e:
            detail=(' errno='+str(e.errno)+': '+os.strerror(e.errno)) if isinstance(e.errno,int) else ': runtime OS operation failed'
            self.save('FAILED','failed',True,type(e).__name__+detail)
        except Exception as e:self.save('FAILED','failed',True,type(e).__name__+': development controller failed; verify runtime')
        finally:
            if self.broker:self.broker.active=False;self.broker.shutdown();self.broker.server_close()
def preflight(req):
    p=req['policy'];checks=[]
    def check(id,fn):
        try:detail=str(fn());checks.append({'id':id,'ok':True,'detail':detail[:200]})
        except Exception:checks.append({'id':id,'ok':False,'detail':'Unavailable; verify configured '+id})
    check('identity',identity)
    check('isolation',lambda:host(['docker','info','--format','{{.ServerVersion}}']) if os.getuid()>0 else (_ for _ in ()).throw(ValueError('Nonroot required')))
    check('image',lambda:host(['docker','image','inspect',p['image'],'--format','{{.Id}}']))
    probe="const fs=require('node:fs'),cp=require('node:child_process');if(process.getuid()===0)process.exit(1);for(const x of [['git',['--version']],['python3',['--version']]])if(cp.spawnSync(x[0],x[1]).status!==0)process.exit(2);let denied=false;try{fs.writeFileSync('/factory-write-probe','x')}catch(e){denied=true}if(!denied)process.exit(3);const s=fs.readFileSync('/proc/self/status','utf8');if(!/NoNewPrivs:\\s+1/.test(s)||!/CapEff:\\s+0+\\b/.test(s))process.exit(4);console.log('nonroot git/python/node; readonly root; no capabilities')"
    check('runtime',lambda:host(['docker','run','--rm','--network','none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit','32','--memory','256m','--cpus','1','--user',str(os.getuid())+':'+str(os.getgid()),p['image'],'node','-e',probe],30))
    check('tool',lambda: 'installed' if pathlib.Path(p['toolPath']).is_file() and os.access(p['toolPath'],os.X_OK) else (_ for _ in ()).throw(ValueError()))
    check('tool-runtime',lambda:host(['docker','run','--rm','--network','none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit','32','--memory','512m','--cpus','1','--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,nosuid,nodev,size=64m','--env','HOME=/tmp','--mount','type=bind,src='+p['toolPath']+',dst=/tools/claude,readonly',p['image'],'/tools/claude','--version'],30))
    check('model',lambda:model_connection(p))
    check('disk',lambda:'sufficient' if shutil.disk_usage(ROOT).free//1048576>=p['minDiskMb'] else (_ for _ in ()).throw(ValueError()))
    check('baseline',lambda:host(['git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',req['repositoryPath'],'cat-file','-t',req['baseline']]))
    check('checks',lambda:'configured' if p['checks'] and p['criteriaApproved'] else (_ for _ in ()).throw(ValueError()))
    return {'ready':all(x['ok'] for x in checks),'checks':checks}
def dispatch(req):
    if req['action']=='preflight':return preflight(req)
    task=req['task'];tid=task['id'];g=task['development']['generation']
    if not re.fullmatch(r'factory_[A-Za-z0-9_-]+',tid) or not isinstance(g,int) or g<1:raise ValueError('Invalid task')
    d=safe_dir(ROOT/tid);record=d/('receipt-'+str(g)+'.json')
    if req['action'] in ('artifact','import-artifact') and task.get('identity')!=identity():raise ValueError('Artifact host identity mismatch')
    if req['action']=='import-artifact':
        dependency=task['development'].get('dependency')
        if not dependency:raise ValueError('Dependency not authorized')
        data,metadata=bundle_envelope(req.get('artifact'),dependency['sha'])
        store_bundle(d/('dependency-'+str(g)+'.bundle'),data);atomic(d/('dependency-'+str(g)+'.json'),metadata)
        return metadata
    if req['action']=='artifact':
        receipt=read_json(record);state=receipt.get('result',{}).get('development',{});metadata=state.get('artifact',{})
        if receipt.get('status')!='succeeded' or not receipt.get('finished') or state.get('stage')!='READY' or not req.get('sha') or state.get('sha')!=req['sha'] or metadata.get('sha')!=req['sha']:raise ValueError('Exact READY artifact required')
        data=read_bundle(d/('artifact-'+str(g)+'.bundle'))
        envelope={**metadata,'base64':base64.b64encode(data).decode()};bundle_envelope(envelope,req['sha'])
        return envelope
    if req['action']=='status':
        if not record.exists():return {'status':'unknown','seq':1,'identity':identity(),'finished':False,'error':'No receipt; never replay automatically','result':{'development':{'generation':g,'stage':'VERIFYING'}}}
        result=read_json(record)
        if result.get('status')=='running' and not alive(result):result.update(status='unknown',seq=result.get('seq',0)+1,finished=False,error='Controller liveness unverified; retain capacity')
        return result
    if req['action']=='inspect':
        r=read_json(record);return {'process':alive(r),'fresh':time.time()-r.get('at',0)<3600,'commit':r.get('result',{}).get('development',{}).get('sha'),'cpu':None}
    if req['action']=='stop':
        atomic(d/('control-'+str(g)+'.json'),{'action':req['control']})
        # Worker observes cancellation, kills exact task container and records completion.
        deadline=time.time()+15
        while time.time()<deadline:
            r=read_json(record)
            if r.get('finished'):return r
            time.sleep(.2)
        r=read_json(record);r.update(status='unknown',finished=False,seq=r.get('seq',0)+1,error='Termination not confirmed');return r
    if req['action']!='start':raise ValueError('Invalid action')
    with open(d/'launch.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if record.exists():return read_json(record)
        if identity()!=task['identity']:raise ValueError('Machine identity mismatch')
        result=preflight({'policy':task['development']['policy'],'baseline':task['development']['baseline'],'repositoryPath':task['repositoryPath']})
        if not result['ready']:return {'status':'failed','seq':1,'identity':identity(),'finished':True,'error':'Development preflight failed','result':{'development':{'generation':g,'stage':'FAILED','preflight':result}}}
        script=d/('worker-'+str(g)+'.py');script.write_text(_SOURCE);script.chmod(0o600)
        request=d/('request-'+str(g)+'.json');atomic(request,req)
        atomic(record,{'status':'running','seq':1,'identity':identity(),'finished':False,'at':time.time(),'result':{'development':{'generation':g,'stage':'START','round':task['development'].get('round',0)}}})
        with open(d/('controller-'+str(g)+'.log'),'ab') as log:
            subprocess.Popen([sys.executable,'-I',str(script),'--run',str(request)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,env={**git_env(),'HOME':str(pathlib.Path.home())})
        return read_json(record)
if len(sys.argv)>2 and sys.argv[1]=='--run':
    request=read_json(pathlib.Path(sys.argv[2]));directory=pathlib.Path(sys.argv[2]).parent
    with open(directory/'execution.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX);Controller(request,directory).execute()
else:
    try:print(json.dumps(dispatch(json.load(sys.stdin))),flush=True)
    except Exception as e:print(json.dumps({'error':type(e).__name__+': development request failed'}),flush=True);sys.exit(1)
`;
