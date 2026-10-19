/** Trusted host publisher: never executes candidate files, hooks, filters or checkout scripts.
 * Credentials live only in an owner-only host file and HTTPS requests / trusted git children. */
export const DELIVERY_WORKER = String.raw`
import os,sys,json,pathlib,subprocess,hashlib,base64,re,stat,fcntl,time,urllib.request,urllib.error,urllib.parse,tempfile,calendar

class PublisherRefusal(ValueError):pass
class PublisherRejected(PublisherRefusal):pass

os.umask(0o077)

def safe_dir(path):
    if any(p.is_symlink() for p in (path,*path.parents)):raise PublisherRefusal('Unsafe publisher path')
    path.mkdir(parents=True,exist_ok=True,mode=0o700)
    if path.stat().st_uid!=os.getuid():raise PublisherRefusal('Publisher directory owner mismatch')
    return path
def read_private(path,limit=1572864):
    if any(p.is_symlink() for p in (path,*path.parents)):raise PublisherRefusal('Unsafe publisher file')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as f:
        st=os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077:raise PublisherRefusal('Owner-only regular publisher file required')
        raw=f.read(limit+1)
    if len(raw)>limit:raise PublisherRefusal('Publisher evidence exceeds limit')
    return raw
def atomic(path,value):
    fd=os.open(path.with_suffix('.tmp'),os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
    os.replace(path.with_suffix('.tmp'),path)
def valid_request(r):
    p=r.get('policy',{})
    if r.get('action') not in ('preflight','snapshot','artifact','sync-artifact','push','pr','merge'):raise PublisherRefusal('Fixed publisher operation required')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',p.get('repository','')) or not re.fullmatch(r'[-A-Za-z0-9_+/=]{1,200}',p.get('repositoryNodeId','')):raise PublisherRefusal('Repository identity required')
    target=p.get('target','')
    if not re.fullmatch(r'[A-Za-z0-9_./-]{1,180}',target) or '..' in target or target.startswith(('/', '.', 'factory/')) or target.endswith(('/', '.')):raise PublisherRefusal('Invalid target')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',p.get('credentialRef','')):raise PublisherRefusal('Credential reference required')
    merge=p.get('mergeIdentity')
    if merge is not None:
        if not isinstance(merge,dict) or set(merge)!={'appId','installationId','credentialRef','rulesetId'} or any(type(merge.get(k)) is not int or merge[k]<1 for k in ('appId','installationId','rulesetId')) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',str(merge.get('credentialRef',''))) or merge['credentialRef']==p['credentialRef']:raise PublisherRefusal('Pinned separate merge identity required')
    if r['action']!='preflight':
        if not re.fullmatch(r'factory_[A-Za-z0-9_-]+',r.get('taskId','')) or r.get('branch')!='factory/'+r['taskId'] or not re.fullmatch(r'[a-f0-9]{40}',r.get('sha','')):raise PublisherRefusal('Exact task candidate and branch required')
    if any(k in r for k in ('argv','force','token','url')):raise PublisherRefusal('General publishing forbidden')
    return p
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**kw):return None
class Publisher:
    def __init__(self,r):
        self.remote_write_started=False
        self.r=r;self.p=valid_request(r);self.repo=self.p['repository'];self.task=r.get('taskId','preflight')
        self.root=safe_dir(pathlib.Path.home()/'.local/state/ppeng-factory/publisher')
        self.directory=safe_dir(self.root/self.task);self.gitdir=self.directory/'objects.git'
        private=pathlib.Path.home()/'.config/ppeng-factory/publishers'/(self.p['credentialRef']+'.json')
        value=json.loads(read_private(private,16384))
        if value.get('repositoryNodeId')!=self.p['repositoryNodeId'] or value.get('repository')!=self.repo:raise PublisherRefusal('Credential target binding mismatch')
        self.git_proxy=value.get('gitProxy')
        if self.git_proxy is not None:
            match=re.fullmatch(r'socks5h://127[.]0[.]0[.]1:([0-9]{1,5})',self.git_proxy) if isinstance(self.git_proxy,str) else None
            if not match or not 1<=int(match.group(1))<=65535:raise PublisherRefusal('Owner-local Git connection proxy required')
        self.key=value['token']
        if not isinstance(self.key,str) or not self.key or len(self.key)>16384 or any(ord(c)<33 or ord(c)>126 for c in self.key):raise PublisherRefusal('Invalid publisher credential format')
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect)
    def request(self,url,method='GET',body=None,missing=False,credential=None,publication=True):
        key=self.key if credential is None else credential
        if not isinstance(key,str) or not key or any(ord(c)<33 or ord(c)>126 for c in key):raise PublisherRefusal('Invalid API credential')
        req=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,method=method,headers={'authorization':'Bearer '+key,'accept':'application/vnd.github+json','x-github-api-version':'2022-11-28','content-type':'application/json','user-agent':'ppeng-factory-publisher'})
        writing=publication and method in ('POST','PUT','PATCH','DELETE')
        if writing:self.remote_write_started=True
        try:
            with self.opener.open(req,timeout=20) as res:
                data=res.read(2097153)
                if len(data)>2097152:raise PublisherRefusal('API evidence exceeds bounded page; manual recovery required')
                return json.loads(data)
        except urllib.error.HTTPError as e:
            if e.code==404 and missing:return None
            refusal=PublisherRejected if writing and e.code in (400,401,403,404,405,409,410,422) else PublisherRefusal
            raise refusal('Publisher API refused HTTP '+str(e.code)) from None
    def api(self,path,method='GET',body=None,missing=False,credential=None):
        url='https://api.github.com/user' if path=='@publisher' else 'https://api.github.com/repos/'+self.repo+('/'+path if path else '')
        return self.request(url,method,body,missing,credential)
    def app_api(self,path,credential,method='GET',body=None):
        if not re.fullmatch(r'app|app/installations/[0-9]+(?:/access_tokens)?|installation/repositories',path):raise PublisherRefusal('Fixed App credential operation required')
        return self.request('https://api.github.com/'+path,method,body,credential=credential,publication=False)
    def validate_merge_rules(self,rule):
        names=rule.get('conditions',{}).get('ref_name',{})
        actors=rule.get('bypass_actors',[])
        if rule.get('target')!='branch' or rule.get('enforcement')!='active' or names.get('include')!=['~ALL'] or names.get('exclude')!=['refs/heads/'+self.p['target']] or not any(r.get('type')=='update' for r in rule.get('rules',[])) or actors!=[{'actor_id':5,'actor_type':'RepositoryRole','bypass_mode':'always'}]:raise PublisherRefusal('Active all-other-branches merge identity fence required')
    def app_jwt(self,settings):
        key=settings.get('privateKey')
        if not isinstance(key,str) or len(key)>16384 or not key.startswith(('-----BEGIN RSA PRIVATE KEY-----','-----BEGIN PRIVATE KEY-----')):raise PublisherRefusal('Private merge App key required')
        encode=lambda data:base64.urlsafe_b64encode(data).rstrip(b'=').decode()
        now=int(time.time());message=encode(json.dumps({'alg':'RS256','typ':'JWT'},separators=(',',':')).encode())+'.'+encode(json.dumps({'iss':settings['appId'],'iat':now-60,'exp':now+540},separators=(',',':')).encode())
        with tempfile.TemporaryDirectory(prefix='app-sign-',dir=self.directory) as directory:
            private=pathlib.Path(directory)/'key.pem';payload=pathlib.Path(directory)/'message'
            private.write_text(key);os.chmod(private,0o600);payload.write_text(message)
            try:signature=subprocess.check_output(['openssl','dgst','-sha256','-sign',str(private),str(payload)],env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/nonexistent'},stderr=subprocess.DEVNULL,timeout=10)
            except (OSError,subprocess.SubprocessError):raise PublisherRefusal('Merge App signing unavailable') from None
        return message+'.'+encode(signature)
    def merge_scope(self,repo):
        config=self.p.get('mergeIdentity')
        if not config:return None
        self.validate_merge_rules(self.api('rulesets/'+str(config['rulesetId'])))
        path=pathlib.Path.home()/'.config/ppeng-factory/publishers'/(config['credentialRef']+'.json')
        settings=json.loads(read_private(path,32768))
        if settings.get('repository')!=self.repo or settings.get('repositoryNodeId')!=self.p['repositoryNodeId'] or settings.get('appId')!=config['appId'] or settings.get('installationId')!=config['installationId']:raise PublisherRefusal('Merge credential target or identity mismatch')
        jwt=self.app_jwt(settings);app=self.app_api('app',jwt);installation=self.app_api('app/installations/'+str(config['installationId']),jwt)
        permissions=installation.get('permissions',{})
        if app.get('id')!=config['appId'] or installation.get('app_id')!=config['appId'] or installation.get('id')!=config['installationId'] or installation.get('suspended_at') or permissions.get('contents')!='write' or permissions.get('pull_requests')!='write' or any(k not in ('contents','pull_requests','metadata') and v!='none' for k,v in permissions.items()):raise PublisherRefusal('Least-privilege merge App installation required')
        self.merge_jwt=jwt;self.merge_repository_id=repo['id']
        return {'appId':config['appId'],'installationId':config['installationId'],'login':app['slug'],'rulesetId':config['rulesetId']}
    def merge_token(self):
        config=self.p['mergeIdentity'];token=self.app_api('app/installations/'+str(config['installationId'])+'/access_tokens',self.merge_jwt,'POST',{'repository_ids':[self.merge_repository_id],'permissions':{'contents':'write','pull_requests':'write'}})
        permissions=token.get('permissions',{})
        if permissions.get('contents')!='write' or permissions.get('pull_requests')!='write' or any(k not in ('contents','pull_requests','metadata') and v!='none' for k,v in permissions.items()):raise PublisherRefusal('Merge token permissions exceed approved scope')
        try:expiry=calendar.timegm(time.strptime(token['expires_at'],'%Y-%m-%dT%H:%M:%SZ'))
        except (KeyError,ValueError):raise PublisherRefusal('Merge token expiry required') from None
        if not time.time()+30<expiry<time.time()+4000:raise PublisherRefusal('Bounded merge token expiry required')
        scope=self.app_api('installation/repositories',token['token']);repositories=scope.get('repositories',[])
        if scope.get('total_count')!=1 or len(repositories)!=1 or repositories[0].get('id')!=self.merge_repository_id or repositories[0].get('node_id')!=self.p['repositoryNodeId']:raise PublisherRefusal('Merge token must be scoped to the exact repository')
        return token['token']
    def git(self,*args,network=False):
        env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/nonexistent','LANG':'C.UTF-8','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0'}
        config=['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','protocol.file.allow=always','-c','protocol.ext.allow=never','-c','credential.helper=','-c','core.attributesFile=/dev/null']
        if network:
            # Credential remains outside argv and candidate workspace. No shell or hooks invoked.
            env.update(GIT_CONFIG_COUNT='1',GIT_CONFIG_KEY_0='http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0='Authorization: Basic '+base64.b64encode(('x-access-token:'+self.key).encode()).decode())
            if getattr(self,'git_proxy',None):env.update(GIT_CONFIG_COUNT='2',GIT_CONFIG_KEY_1='http.proxy',GIT_CONFIG_VALUE_1=self.git_proxy)
        return subprocess.check_output(['git',*config,'--git-dir='+str(self.gitdir),*args],env=env,stderr=subprocess.DEVNULL,timeout=50).decode('utf-8','replace').strip()
    def objects(self):
        if self.gitdir.is_symlink():raise PublisherRefusal('Unsafe object database')
        if not self.gitdir.exists():self.git('init','--bare',str(self.gitdir))
        self.git('fetch','--no-tags','https://github.com/'+self.repo+'.git','refs/heads/'+self.p['target']+':refs/factory/base',network=True)
    def secret_text(self,text):
        return bool(re.search(r'-----BEGIN .*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-[A-Za-z0-9_-]{16})|(?:api[_-]?key|secret|password|token)\s*[:=]\s*[\x22\x27][A-Za-z0-9_+/=-]{16,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}',text,re.I))
    def scan_objects(self,baseline,sha):
        objects=self.git('rev-list','--objects','--no-object-names',sha,'^'+baseline).splitlines()
        if len(objects)>2000:raise PublisherRefusal('Privacy history object budget exceeded')
        findings=[];total=0
        for oid in objects:
            if not re.fullmatch(r'[a-f0-9]{40,64}',oid):raise PublisherRefusal('Invalid history object')
            kind=self.git('cat-file','-t',oid)
            if kind not in ('blob','commit'):continue
            size=int(self.git('cat-file','-s',oid));total+=size
            if size>1048576 or total>8388608:raise PublisherRefusal('Privacy history size budget exceeded')
            if self.secret_text(self.git('cat-file',kind,oid)):findings.append({'object':oid,'kind':'potential-secret-in-history'})
        names=self.git('log','--format=','--name-only','-z',baseline+'..'+sha).split('\0')
        if any(re.search(r'(^|/)(?:[.]env(?:[.]|$)|id_rsa|id_ed25519|credentials)',name.strip('\n')) for name in names):findings.append({'kind':'sensitive-file-in-history'})
        return findings
    def artifact(self):
        g=self.r.get('generation');ident=hashlib.sha256(pathlib.Path('/etc/machine-id').read_bytes().strip()).hexdigest()
        if not isinstance(g,int) or g<1 or self.r.get('identity')!=ident:raise PublisherRefusal('Machine or generation mismatch')
        directory=pathlib.Path.home()/'.local/state/ppeng-factory/development'/self.task
        receipt=json.loads(read_private(directory/('receipt-'+str(g)+'.json')));state=receipt.get('result',{}).get('development',{})
        a=state.get('artifact',{});data=read_private(directory/('artifact-'+str(g)+'.bundle'),700000)
        if receipt.get('finished') is not True or receipt.get('identity')!=ident or state.get('stage')!='READY' or state.get('sha')!=self.r['sha'] or a.get('sha')!=self.r['sha'] or a.get('bytes')!=len(data) or a.get('digest')!=hashlib.sha256(data).hexdigest():raise PublisherRefusal('READY artifact mismatch')
        self.objects();path=self.directory/('artifact-'+str(g)+'.bundle')
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as f:f.write(data)
        self.git('bundle','verify',str(path));self.git('fetch','--no-tags',str(path),'HEAD:refs/factory/candidate')
        if self.git('rev-parse','refs/factory/candidate')!=self.r['sha']:raise PublisherRefusal('Artifact SHA differs')
        files=self.git('diff','--name-only',a['baseline'],a['sha']).splitlines();taskfiles=set(self.git('diff','--name-only',self.r['baseSha'],a['sha']).splitlines());findings=[];sensitive=[];total=0
        for name in files:
            if name.startswith('.github/workflows/') and self.git('rev-parse',a['sha']+':'+name)!=self.p.get('workflowDigests',{}).get(name):findings.append({'path':name,'kind':'unconfirmed-ci-source'})
            if name in taskfiles and (name.startswith(('.github/','deploy/','scripts/release','acceptance/')) or re.search(r'(delivery|publisher|authorization|security|ci-gate)',name,re.I)):sensitive.append(name)
            # Scan complete changed blobs with explicit bounds, including tests and configuration.
            try:
                size=int(self.git('cat-file','-s',a['sha']+':'+name));total+=size
                if size>1048576 or total>8388608:raise PublisherRefusal('Privacy scan bound exceeded')
                blob=self.git('cat-file','blob',a['sha']+':'+name)
            except subprocess.CalledProcessError:continue # deleted file
            if re.search(r'-----BEGIN .*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-[A-Za-z0-9_-]{16})|(?:api[_-]?key|secret|password|token)\s*[:=]\s*[\x22\x27][A-Za-z0-9_+/=-]{16,}',blob,re.I) or re.search(r'(^|/)(?:[.]env(?:[.]|$)|id_rsa|id_ed25519|credentials)',name):findings.append({'path':name,'kind':'potential-secret'})
        findings+=self.scan_objects(a['baseline'],a['sha'])
        return {**a,'identity':ident,'valid':True,'privacy':{'sha':a['sha'],'findings':findings},'sensitive':sensitive}
    def protections(self):
        protection=self.api('branches/'+urllib.parse.quote(self.p['target'],safe='')+'/protection',missing=True)
        if not protection:return False,False,None
        checks=protection.get('required_status_checks') or {};bound={(x.get('context'),x.get('app_id')) for x in checks.get('checks',[])}
        required=all((c['job'],c['appId']) in bound for c in self.p['requiredChecks'])
        strict=checks.get('strict') is True and protection.get('enforce_admins',{}).get('enabled') is True and required and not protection.get('allow_force_pushes',{}).get('enabled',False) and not protection.get('allow_deletions',{}).get('enabled',False)
        return True,strict,protection
    def downstream(self):
        if not self.p.get('downstream',{}).get('confirmed') or self.p['downstream'].get('deploys'):return False
        pages=self.api('pages',missing=True)
        if pages and (pages.get('source',{}).get('branch')==self.p['target'] or pages.get('build_type')=='workflow'):return False
        # Require a reviewed allowlist of immutable workflow blobs on the actual target.
        approved=self.p.get('workflowDigests',{})
        files=self.api('contents/.github/workflows?ref='+urllib.parse.quote(self.p['target'],safe=''),missing=True)
        if not isinstance(files,list) or len(files)>50:return False
        for item in files:
            if item.get('type')!='file' or approved.get(item['path'])!=item['sha']:return False
        hooks=self.api('hooks?per_page=100')
        if hooks:return False # unknown external automation cannot be assumed harmless
        return True
    def facts(self):
        repo=self.api('');
        if repo.get('node_id')!=self.p['repositoryNodeId']:raise PublisherRefusal('Canonical repository mismatch')
        publisher=self.api('@publisher')
        variables=self.api('actions/variables?per_page=100')
        if variables['total_count']>100:raise PublisherRefusal('CI configuration evidence pagination required')
        config_digest=hashlib.sha256(json.dumps(sorted([[v['name'],v['value']] for v in variables['variables']]),ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        base=self.api('git/ref/heads/'+urllib.parse.quote(self.p['target'],safe=''))['object']['sha'];protected,strict,protection=self.protections()
        merge_publisher=None;merge_reason=None
        try:merge_publisher=self.merge_scope(repo)
        except PublisherRefusal as error:merge_reason=str(error)
        except (OSError,KeyError,ValueError):merge_reason='Merge identity unavailable; inspect private reference'
        out={'publisher':{'id':publisher['id'],'login':publisher['login']},'ciVariablesCount':variables['total_count'],'ciConfigDigest':config_digest,'ciConfigurationConfirmed':config_digest==self.p.get('ciVariablesDigest') if self.p.get('ciVariablesDigest') else variables['total_count']==0,'deletesBranchOnMerge':repo.get('delete_branch_on_merge',False),'repositoryNodeId':repo['node_id'],'baseSha':base,'protected':protected,'strict':strict,'canPush':repo.get('permissions',{}).get('push',False),'canMerge':repo.get('permissions',{}).get('push',False),'atomicTarget':merge_publisher is not None,'mergePublisher':merge_publisher,'mergeIdentityReason':merge_reason,'downstreamSafe':self.downstream(),'headSha':None,'pr':None,'checks':[],'reviewApproved':False,'mergeable':False}
        operation=self.r.get('pendingOperationId','')
        if re.fullmatch(r'[a-f0-9-]{36}',operation):
            journal=self.directory/('operation-'+operation+'.json')
            if journal.exists():out['operation']=json.loads(read_private(journal))
        if self.task=='preflight':return out
        head=self.api('git/ref/heads/'+urllib.parse.quote(self.r['branch'],safe=''),missing=True);out['headSha']=head['object']['sha'] if head else None
        pulls=self.api('pulls?state=all&head='+urllib.parse.quote(self.repo.split('/')[0]+':'+self.r['branch'],safe='')+'&per_page=100')
        if len(pulls)>1:raise PublisherRefusal('Duplicate task PRs require decision')
        if not pulls:return out
        pr=self.api('pulls/'+str(pulls[0]['number']));marker='<!-- ppeng-factory:'+self.task+' -->'
        out['pr']={'number':pr['number'],'url':pr['html_url'],'head':pr['head']['sha'],'base':pr['base']['ref'],'branch':pr['head']['ref'],'marker':self.task if marker in (pr.get('body') or '') else None,'state':'merged' if pr.get('merged') else pr['state'],'mergeSha':pr.get('merge_commit_sha')}
        if pr['head']['repo']['node_id']!=repo['node_id'] or pr['base']['repo']['node_id']!=repo['node_id']:raise PublisherRefusal('PR repository changed')
        out['mergeable']=pr.get('mergeable') is True and pr.get('mergeable_state')=='clean'
        # GitHub reports BLOCKED until all project-required approvals/rules resolve.
        out['reviewApproved']=pr.get('mergeable_state')=='clean'
        runs=self.api('actions/runs?event=pull_request&head_sha='+self.r['sha']+'&per_page=100')['workflow_runs']
        if len(runs)>=100:raise PublisherRefusal('CI evidence pagination required')
        for run in runs:
            if not any(c['workflowId']==run['workflow_id'] for c in self.p['requiredChecks']):continue
            matches=[p for p in run.get('pull_requests',[]) if p['number']==pr['number'] and p['head']['sha']==self.r['sha']]
            if not matches:continue
            runbase=matches[0]['base']['sha']
            if run['run_attempt']>self.p['maxRetries']+1:out['ciRetryExceeded']=True
            if run['run_attempt']>6:raise PublisherRefusal('CI retry evidence exceeds bounded policy')
            for attempt in range(1,run['run_attempt']+1):
                jobs=self.api('actions/runs/'+str(run['id'])+'/attempts/'+str(attempt)+'/jobs?per_page=100')['jobs']
                if len(jobs)>=100:raise PublisherRefusal('CI jobs pagination required')
                for job in jobs:
                    check=self.api('check-runs/'+str(job['check_run_url'].rsplit('/',1)[-1])) if job.get('check_run_url') else None
                    annotations=[]
                    if check and job.get('conclusion')=='failure':
                        values=self.api('check-runs/'+str(check['id'])+'/annotations?per_page=100')
                        if len(values)>=100:raise PublisherRefusal('CI failure evidence pagination required')
                        annotations=[{'path':v.get('path'),'level':v.get('annotation_level'),'message':str(v.get('message','')).replace(self.key,'[REDACTED:PUBLISHER]')[:16384]} for v in values]
                    out['checks'].append({'annotations':annotations,'steps':[{'name':s['name'],'conclusion':s.get('conclusion')} for s in job.get('steps',[])], 'id':job['id'],'runId':run['id'],'workflowId':run['workflow_id'],'job':job['name'],'appId':check.get('app',{}).get('id') if check else None,'sha':run['head_sha'],'baseSha':runbase,'attempt':attempt,'status':job['status'],'conclusion':job['conclusion'],'trusted':bool(check and check.get('check_suite',{}).get('id')==run['check_suite_id']),'url':job['html_url']})
        if pr.get('merged'):
            candidate=self.api('git/commits/'+self.r['sha']);merged=self.api('git/commits/'+pr['merge_commit_sha']);compare=self.api('compare/'+pr['merge_commit_sha']+'...'+base)
            out['merge']={'sha':pr['merge_commit_sha'],'candidate':pr['head']['sha'],'base':merged['parents'][0]['sha'],'onTarget':compare['status'] in ('ahead','identical'),'treeMatches':candidate['tree']['sha']==merged['tree']['sha']}
        return out
    def execute(self):
        action=self.r['action']
        if action in ('preflight','snapshot'):return self.facts()
        if action=='artifact':return self.artifact()
        if action=='sync-artifact':
            self.objects();base=self.r['baseSha'];baseline=self.r['baseline']
            if self.git('rev-parse','refs/factory/base')!=base:raise PublisherRefusal('Target advanced before synchronization')
            path=self.directory/('target-'+base+'.bundle');self.git('bundle','create',str(path),'refs/factory/base','^'+baseline)
            data=read_private(path,700000);target=safe_dir(pathlib.Path.home()/'.local/state/ppeng-factory/development'/self.task);dest=target/('delivery-'+base+'.bundle')
            fd=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as f:f.write(data)
            atomic(target/('delivery-'+base+'.json'),{'baseSha':base,'bytes':len(data),'digest':hashlib.sha256(data).hexdigest()});return {'baseSha':base,'bytes':len(data)}
        if action not in self.p['operations']:raise PublisherRefusal('Operation not granted')
        lockname=hashlib.sha256(json.dumps([self.p['repositoryNodeId'],self.p['target']]).encode()).hexdigest()+'.lock'
        with open(self.root/lockname,'a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            operation=self.r.get('operationId','')
            if not re.fullmatch(r'[a-f0-9-]{36}',operation):raise PublisherRefusal('Durable operation identity required')
            journal=self.directory/('operation-'+operation+'.json')
            if journal.exists():
                prior=json.loads(read_private(journal))
                if not prior.get('completed'):raise RuntimeError('Prior remote outcome remains unknown')
                if prior.get('error'):return {'publisherError':'PublisherRefusal' if prior.get('outcome')=='rejected' else 'UnknownRemoteOutcome','detail':'Prior publisher operation requires reconciliation','publisherFinished':prior.get('outcome')=='rejected'}
                return prior
            f=self.facts()
            if not f['downstreamSafe']:raise PublisherRefusal('Unknown or unauthorized downstream automation')
            if action=='push':
                if f['headSha']==self.r['sha']:return {'reconciled':True}
                a=self.artifact()
                if a['privacy']['findings'] or (a['sensitive'] and self.r.get('sensitiveConfirmedSha')!=self.r['sha']):raise PublisherRefusal('Unresolved privacy or sensitive scope')
                if f['baseSha']!=self.r['baseSha']:raise PublisherRefusal('Target moved; revalidation required')
                self.remote_write_started=True
                self.git('push','https://github.com/'+self.repo+'.git',self.r['sha']+':refs/heads/'+self.r['branch'],network=True)
            if action=='pr':
                if f['pr']:
                    if f['pr']['marker']!=self.task or f['pr']['base']!=self.p['target']:raise PublisherRefusal('Unrelated PR')
                    return {'reconciled':True}
                if f['headSha']!=self.r['sha']:raise PublisherRefusal('Push not verified')
                body='<!-- ppeng-factory:'+self.task+' -->\nRequirement: '+str(self.r.get('requirement',''))[:20000]+'\n\nApproved acceptance:\n'+json.dumps(self.r.get('acceptance',[]),ensure_ascii=False)+'\n\nCandidate: '+self.r['sha']+'\nBaseline: '+self.r['baseSha']+'\nDeployment: deferred.'
                if self.key in body or self.secret_text(body):raise PublisherRefusal('Private data in publication description requires resolution')
                self.api('pulls','POST',{'head':self.r['branch'],'base':self.p['target'],'title':'Factory task '+self.task,'body':body})
            if action=='merge':
                if f['pr'] and f['pr']['state']=='merged':return {'reconciled':True}
                if not f['ciConfigurationConfirmed'] or f['deletesBranchOnMerge'] or not f['strict'] or not f['protected'] or f['baseSha']!=self.r['baseSha'] or not f['reviewApproved'] or not f['mergeable'] or not f['pr'] or f['pr']['head']!=self.r['sha'] or f['pr']['marker']!=self.task or f['pr'].get('base')!=self.p['target'] or f['pr'].get('branch')!=self.r['branch'] or f.get('ciRetryExceeded'):raise PublisherRefusal('Provider merge conditions not satisfied')
                for required in self.p['requiredChecks']:
                    rows=[c for c in f['checks'] if c['workflowId']==required['workflowId'] and c['job']==required['job'] and c['appId']==required['appId'] and c['trusted'] and c.get('sha')==self.r['sha'] and c.get('baseSha')==self.r['baseSha']]
                    run=max([c['runId'] for c in rows] or [0]);latest=max([c['attempt'] for c in rows if c['runId']==run] or [0]);rows=[c for c in rows if c['runId']==run and c['attempt']==latest]
                    if not rows or any(c['conclusion']!='success' or c['status']!='completed' for c in rows):raise PublisherRefusal('Current trusted CI not passed')
                if not f.get('atomicTarget'):raise PublisherRefusal('Provider cannot atomically enforce the authorized merge target; automatic merge stopped')
                # Separate non-admin App is denied every non-target ref by an active server ruleset.
                # Strict target protection and exact head remain server-enforced at the merge transaction.
                token=self.merge_token()
                self.api('pulls/'+str(f['pr']['number'])+'/merge','PUT',{'sha':self.r['sha'],'merge_method':'squash'},credential=token)
            result={'operationId':operation,'action':action,'sha':self.r['sha'],'completed':True,'at':time.time()};atomic(journal,result);return result
req=json.load(sys.stdin)
publisher=None
try:
    publisher=Publisher(req);result=publisher.execute();print(json.dumps(result),flush=True)
except Exception as e:
    known=isinstance(e,PublisherRefusal) and (not getattr(publisher,'remote_write_started',False) or isinstance(e,PublisherRejected))
    if publisher and req.get('action') in ('push','pr','merge') and re.fullmatch(r'[a-f0-9-]{36}',req.get('operationId','')):
        try:atomic(publisher.directory/('operation-'+req['operationId']+'.json'),{'operationId':req['operationId'],'action':req['action'],'sha':req['sha'],'completed':known,'error':True,'outcome':'rejected' if known else 'unknown','at':time.time()})
        except Exception:pass
    # Do not return subprocess stderr, URLs with credentials, token or API bodies.
    print(json.dumps({'publisherError':'PublisherRefusal' if isinstance(e,PublisherRefusal) else type(e).__name__,'publisherFinished':known,'detail':str(e) if isinstance(e,PublisherRefusal) else 'Publisher operation unavailable; reconcile before retry'}),flush=True)
`;
