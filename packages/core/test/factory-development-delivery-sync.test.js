import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sanitizeSpawnEnv } from "../dist/sandbox/env-sanitizer.js";

const worker = readFileSync(
  new URL("../src/factory/development-worker.ts", import.meta.url),
  "utf8",
)
  .split("String.raw`")[1]
  .split("\n`;")[0]
  .split("if len(sys.argv)>2")[0];

function run(t, { repair = false, corrupt = false } = {}) {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), "factory-delivery-sync-")),
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const program = `
import os,sys,json,pathlib,subprocess,hashlib
ns={'__name__':'test'}
exec(${JSON.stringify(worker)},ns)
ns['identity']=lambda:'synthetic-host'
home=pathlib.Path(os.environ['HOME'])
env={'PATH':os.environ['PATH'],'HOME':str(home),'LANG':'C.UTF-8','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_NOSYSTEM':'1','GIT_TERMINAL_PROMPT':'0'}
def git(directory,*args):
 return subprocess.check_output(['git','-c','core.hooksPath=/dev/null','-C',str(directory),*args],env=env,stderr=subprocess.DEVNULL,text=True).strip()
source=home/'source';source.mkdir()
git(source,'init','-b','main');git(source,'config','user.name','Test');git(source,'config','user.email','test@localhost')
(source/'product.py').write_text('def twice(x): return x\\n')
(source/'package.json').write_text('{"name":"synthetic-fixture"}')
git(source,'add','.');git(source,'commit','-m','baseline');base=git(source,'rev-parse','HEAD')
directory=ns['safe_dir'](home/'task');work=directory/'work'
git(home,'clone',str(source),str(work));git(work,'config','user.name','Test');git(work,'config','user.email','test@localhost')
frozen=b'from product import twice\\nassert twice(1)==2, "AC-1: twice positive integer"\\n'
(work/'test_behavior.py').write_bytes(frozen)
red=subprocess.run([sys.executable,'-B','test_behavior.py'],cwd=work,env=env,capture_output=True,text=True)
assert red.returncode!=0 and 'AssertionError' in red.stderr
(work/'product.py').write_text('def twice(x): return 2 if x>=0 else 0\\n')
git(work,'add','.');git(work,'commit','-m','local candidate');candidate=git(work,'rev-parse','HEAD')
# The independently advancing target contributes a new immutable regression test.
(source/'upstream.py').write_text('marker="verified target"\\n')
(source/'test_target.py').write_text('from upstream import marker\\nassert marker=="verified target"\\n')
git(source,'add','.');git(source,'commit','-m','advance target');target=git(source,'rev-parse','HEAD')
git(source,'update-ref','refs/factory/base',target)
source_before=git(source,'rev-parse','HEAD')
bundle=directory/('delivery-'+target+'.bundle')
git(source,'bundle','create',str(bundle),'refs/factory/base','^'+base)
data=bundle.read_bytes()
ns['atomic'](directory/('delivery-'+target+'.json'),{'baseSha':target,'bytes':len(data),'digest':('0'*64 if ${corrupt ? "True" : "False"} else hashlib.sha256(data).hexdigest())})
policy={'revision':'approved-policy','timeoutMs':30000,'image':'unused','toolPath':'unused','model':'synthetic','maxRounds':6,'maxRetries':0,'criteria':[{'id':'AC-1'}],'checks':[{'id':'behavior','required':True,'argv':[sys.executable,'-B','-c','exec(open("test_behavior.py").read()); exec(open("test_target.py").read())']}],'baselineFailures':[]}
spec={'generation':2,'round':${repair ? 3 : 2},'baseline':base,'policy':policy,'requirement':'twice every integer, including negatives','deliveryInput':{'baseSha':target,'previousSha':candidate,'repair':${repair ? "True" : "False"},'ci':{'state':'failed','checks':[{'conclusion':'failure','annotation':'twice(-1) must equal -2'}]}}}
request={'task':{'id':'factory_real_git_sync','identity':'synthetic-host','repositoryPath':str(source),'development':spec}}
def initial_digest():
 code=ns['DIGEST'].replace("pathlib.Path('/workspace')",'pathlib.Path('+repr(str(work))+')')
 return json.loads(subprocess.check_output([sys.executable,'-I','-c',code],env=env,text=True))
initial=initial_digest()
prior={'generation':1,'stage':'READY','round':2,'policyRevision':policy['revision'],'sha':candidate,'red':{'exitCode':red.returncode,'reason':'assertion','criteria':['AC-1'],'testDigest':initial['digest'],'files':initial['files']},'protectedDigest':initial['protected'],'manifest':{'baseline':base,'path':str(work)}}
ns['atomic'](directory/'receipt-1.json',{'finished':True,'status':'succeeded','result':{'development':prior}})
c=ns['Controller'](request,directory)
commands=[];agents=[]
# Run the unmodified controller orchestration, Git, digest, checks, review parser,
# receipt journal and artifact exporter. Only container/model boundaries are local adapters.
def command(argv,readonly=False,model=False,private=False):
 mapped=[str(x).replace('/input/',str(c.input)+'/') for x in argv]
 result=subprocess.run(mapped,cwd=c.work,env=env,capture_output=True,text=True,timeout=15)
 commands.append({'argv':argv,'exitCode':result.returncode,'readonly':readonly,'private':private})
 c.output_evidence(result.stdout.encode(),result.stderr.encode(),private)
 return result.returncode,result.stdout+result.stderr
c.command=command
def setup():
 c.input.joinpath('digest.py').write_text(ns['DIGEST'].replace("pathlib.Path('/workspace')",'pathlib.Path('+repr(str(work))+')'))
 c.input.joinpath('export.py').write_text(ns['EXPORT'].replace("pathlib.Path('/tmp/dependency.bundle')",'pathlib.Path('+repr(str(c.input/'export.bundle'))+')'))
 c.state['manifest']={'baseline':base,'path':str(work),'sourcePath':str(source),'independentGit':True,'sourceBefore':source_before,'sourceAfter':source_before}
 c.state['dependencies']={'exitCode':0,'isolated':True}
c.setup=setup
def agent(prompt,review=False):
 agents.append({'review':review,'prompt':prompt,'round':c.round})
 if review:return json.dumps({'verdict':'CLEAN','issues':[]})
 assert 'actual trusted remote CI failure' in prompt
 (work/'product.py').write_text('def twice(x): return 2*x\\n')
 return 'DONE'
c.agent=agent
c.execute()
receipt=json.loads(c.record.read_text());state=receipt['result']['development'];final=git(work,'rev-parse','HEAD')
ancestor=subprocess.run(['git','-C',str(work),'merge-base','--is-ancestor',target,final],env=env,capture_output=True).returncode==0
artifact=state.get('artifact',{});artifact_path=directory/'artifact-2.bundle'
artifact_valid=artifact_path.exists() and artifact.get('digest')==hashlib.sha256(artifact_path.read_bytes()).hexdigest() and artifact.get('bytes')==artifact_path.stat().st_size
if artifact_path.exists():git(work,'bundle','verify',str(artifact_path))
negative=int(subprocess.check_output([sys.executable,'-B','-c','from product import twice; print(twice(-1))'],cwd=work,env=env,text=True))
print(json.dumps({'receipt':receipt,'base':base,'target':target,'candidate':candidate,'final':final,'negative':negative,'targetAncestor':ancestor,'originalTestUnchanged':(work/'test_behavior.py').read_bytes()==frozen,'sourceUnchanged':git(source,'rev-parse','HEAD')==source_before and not git(source,'status','--porcelain'),'artifactValid':artifact_valid,'agents':agents,'commands':commands,'originalManifest':json.loads((directory/'receipt-1.json').read_text())['result']['development']['manifest']}))
`;
  const result = spawnSync("python3", ["-I", "-c", program], {
    env: { ...sanitizeSpawnEnv({ stripCredentials: true }), HOME: home },
    encoding: "utf8",
    timeout: 40000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertReady(r, round) {
  const state = r.receipt.result.development;
  assert.equal(r.receipt.status, "succeeded");
  assert.equal(state.stage, "READY");
  assert.equal(state.round, round);
  assert.equal(state.generation, 2);
  assert.equal(state.manifest.baseline, r.base);
  assert.equal(r.originalManifest.baseline, r.base);
  assert.equal(state.deliveryBase, r.target);
  assert.equal(r.targetAncestor, true);
  assert.notEqual(state.sha, r.candidate);
  assert.equal(state.sha, r.final);
  assert.equal(r.originalTestUnchanged, true);
  assert.equal(r.sourceUnchanged, true);
  assert.equal(r.artifactValid, true);
  assert.equal(state.artifact.sha, state.sha);
  assert.equal(state.artifact.baseline, r.base);
  assert.equal(state.greenTestDigest, state.red.testDigest);
  assert.ok(
    state.deliveryFrozenFiles.some(([name]) => name === "test_target.py"),
  );
  assert.equal(state.deliverySyncs.at(-1).exitCode, 0);
  assert.ok(
    state.checks.every((check) => check.passed && check.sha === state.sha),
  );
  assert.equal(state.review.sha, state.sha);
  assert.equal(state.review.covered, true);
  assert.ok(
    r.agents
      .filter((a) => a.review)
      .every(
        (a) => a.prompt.includes(r.target) && a.prompt.includes(state.sha),
      ),
  );
  assert.ok(
    r.commands.some((c) => c.argv.includes("merge") && c.exitCode === 0),
  );
  assert.ok(
    r.commands.some((c) => c.argv.includes("/input/export.py") && c.private),
  );
}

test("real Git target synchronization preserves original frozen tests and reruns checks/review without resetting rounds [AC:multi-machine-controlled-delivery#AC-12] [AC:multi-machine-controlled-delivery#AC-14]", (t) => {
  const result = run(t);
  assertReady(result, 2);
  assert.equal(result.agents.filter((a) => !a.review).length, 0);
});

test("real Git synchronization and CI repair retain consumed rounds and export the newly checked candidate [AC:multi-machine-controlled-delivery#AC-20] [AC:multi-machine-controlled-delivery#AC-22]", (t) => {
  const result = run(t, { repair: true });
  assertReady(result, 3);
  assert.equal(
    result.negative,
    -2,
    "the real retained production code fixes the trusted CI failure",
  );
  const repairs = result.agents.filter((a) => !a.review);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].round, 3);
  assert.match(repairs[0].prompt, /twice\(-1\) must equal -2/);
});

test("corrupted target bundle metadata refuses synchronization before changing the retained candidate [AC:multi-machine-controlled-delivery#AC-8]", (t) => {
  const result = run(t, { corrupt: true });
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.receipt.result.development.stage, "DEFERRED");
  assert.match(result.receipt.error, /integrity mismatch/);
  assert.equal(result.final, result.candidate);
  assert.equal(result.originalTestUnchanged, true);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.agents.length, 0);
  assert.equal(result.artifactValid, false);
});
