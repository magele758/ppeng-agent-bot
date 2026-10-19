import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DELIVERY_WORKER } from "../dist/factory/delivery-worker.js";
import { sanitizeSpawnEnv } from "../dist/sandbox/env-sanitizer.js";
function python(t, body) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "factory-publisher-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const program = `ns={}\nexec(${JSON.stringify(DELIVERY_WORKER.split("req=json.load(sys.stdin)")[0])},ns)\nimport os,pathlib,json\n${body}`;
  const r = spawnSync("python3", ["-I", "-c", program], {
    env: { ...sanitizeSpawnEnv({ stripCredentials: true }), HOME: home },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
test("actual publisher refuses general commands and protected target writes before opening credentials [AC:multi-machine-controlled-delivery#AC-7]", (t) => {
  const r = python(
    t,
    `p={'repository':'owner/repo','repositoryNodeId':'R_123','target':'main','credentialRef':'test'}\nresults=[]\nfor request in [{'policy':p,'action':'shell'},{'policy':p,'action':'push','taskId':'factory_x','branch':'main','sha':'a'*40}]:\n try:ns['valid_request'](request);results.append(True)\n except ValueError:results.append(False)\nprint(json.dumps(results))`,
  );
  assert.deepEqual(r, [false, false]);
});
test("actual publisher refuses readable credential files, symlinks and oversize evidence", (t) => {
  const r = python(
    t,
    `root=pathlib.Path(os.environ['HOME']);path=root/'credential';path.write_text('secret');os.chmod(path,0o644)\nresults=[]\nfor candidate,limit in [(path,100)]:\n try:ns['read_private'](candidate,limit);results.append(True)\n except ValueError:results.append(False)\nos.chmod(path,0o600);link=root/'link';link.symlink_to(path)\nfor candidate,limit in [(link,100),(path,2)]:\n try:ns['read_private'](candidate,limit);results.append(True)\n except ValueError:results.append(False)\nprint(json.dumps(results))`,
  );
  assert.deepEqual(r, [false, false, false]);
});
test("actual host git ignores global helpers and repository hooks without checking out candidate code", (t) => {
  const r = python(
    t,
    `publisher=ns['Publisher'].__new__(ns['Publisher']);publisher.gitdir=pathlib.Path(os.environ['HOME'])/'objects.git';publisher.git('init','--bare',str(publisher.gitdir))\nhook=publisher.gitdir/'hooks'/'pre-push';hook.write_text('#!/bin/sh\\ntouch '+os.environ['HOME']+'/executed\\n');os.chmod(hook,0o700)\nprint(json.dumps({'hooks':publisher.git('config','core.hooksPath'),'credentialHelper':publisher.git('config','credential.helper'),'checkedOut':(publisher.gitdir/'sum.mjs').exists(),'executed':(pathlib.Path(os.environ['HOME'])/'executed').exists()}))`,
  );
  assert.equal(r.hooks, "/dev/null");
  assert.equal(r.credentialHelper, "");
  assert.equal(r.checkedOut, false);
  assert.equal(r.executed, false);
});
test("publisher credential references are bound to canonical repository identity", (t) => {
  const r = python(
    t,
    `root=pathlib.Path(os.environ['HOME'])/'.config/ppeng-factory/publishers';root.mkdir(parents=True);(root/'test.json').write_text(json.dumps({'repository':'another/repo','repositoryNodeId':'R_other','token':'test-token'}))\nr={'action':'preflight','policy':{'repository':'owner/repo','repositoryNodeId':'R_123','target':'main','credentialRef':'test'}}\ntry:ns['Publisher'](r);accepted=True\nexcept ValueError:accepted=False\nprint(json.dumps({'accepted':accepted}))`,
  );
  assert.equal(r.accepted, false);
});
test("privacy scan catches a secret deleted from HEAD but still reachable in published history", (t) => {
  const r = python(
    t,
    `import subprocess\nroot=pathlib.Path(os.environ['HOME'])/'repo';root.mkdir()\nclean={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_NOSYSTEM':'1'}\ndef git(*a):return subprocess.check_output(['git','-c','core.hooksPath=/dev/null','-C',str(root),*a],env=clean,stderr=subprocess.DEVNULL,text=True).strip()\ngit('init');git('config','user.name','Test');git('config','user.email','test@localhost');git('commit','--allow-empty','-m','base');base=git('rev-parse','HEAD')\n(root/'sample.txt').write_text('ghp_'+'a'*36);git('add','.');git('commit','-m','temporary content');(root/'sample.txt').unlink();git('add','-u');git('commit','-m','remove temporary content');sha=git('rev-parse','HEAD')\npublisher=ns['Publisher'].__new__(ns['Publisher']);publisher.gitdir=root/'.git'\nprint(json.dumps({'headDiff':git('diff','--name-only',base,sha),'findings':publisher.scan_objects(base,sha)}))`,
  );
  assert.equal(r.headDiff, "");
  assert.ok(r.findings.length > 0);
  assert.ok(!JSON.stringify(r).includes("ghp_"));
});
test("malformed publisher credentials are refused before API calls without echoing their value", (t) => {
  const r = python(
    t,
    `root=pathlib.Path(os.environ['HOME'])/'.config/ppeng-factory/publishers';root.mkdir(parents=True);(root/'test.json').write_text(json.dumps({'repository':'owner/repo','repositoryNodeId':'R_123','token':'credential-value\\nshould-not-escape'}))\nr={'action':'preflight','policy':{'repository':'owner/repo','repositoryNodeId':'R_123','target':'main','credentialRef':'test'}}\ntry:ns['Publisher'](r);result={'accepted':True}\nexcept Exception as e:result={'accepted':False,'error':str(e)}\nprint(json.dumps(result))`,
  );
  assert.equal(r.accepted, false);
  assert.ok(!JSON.stringify(r).includes("credential-value"));
});
test("a private valid target-bound credential initializes without using the network", (t) => {
  const r = python(
    t,
    `root=pathlib.Path(os.environ['HOME'])/'.config/ppeng-factory/publishers';root.mkdir(parents=True);(root/'test.json').write_text(json.dumps({'repository':'owner/repo','repositoryNodeId':'R_123','token':'valid-synthetic-credential'}))\nr={'action':'preflight','policy':{'repository':'owner/repo','repositoryNodeId':'R_123','target':'main','credentialRef':'test'}}\npublisher=ns['Publisher'](r)\nprint(json.dumps({'repository':publisher.repo,'initialized':True}))`,
  );
  assert.equal(r.initialized, true);
  assert.equal(r.repository, "owner/repo");
});
test("legacy Pages publishing from the target branch is an unapproved deployment trigger", (t) => {
  const r = python(
    t,
    `publisher=ns['Publisher'].__new__(ns['Publisher']);publisher.p={'target':'main','downstream':{'confirmed':True,'deploys':False},'workflowDigests':{}}\npublisher.api=lambda path,*a,**k:({'source':{'branch':'main'},'build_type':'legacy'} if path=='pages' else [])\nprint(json.dumps({'safe':publisher.downstream()}))`,
  );
  assert.equal(r.safe, false);
});
test("publisher connection proxy stays owner-local and is used only by trusted Git network calls", (t) => {
  const r = python(
    t,
    `root=pathlib.Path(os.environ['HOME'])/'.config/ppeng-factory/publishers';root.mkdir(parents=True)\ncredential=root/'test.json';credential.write_text(json.dumps({'repository':'owner/repo','repositoryNodeId':'R_123','token':'synthetic-credential','gitProxy':'socks5h://127.0.0.1:41080'}))\npublisher=ns['Publisher']({'action':'preflight','policy':{'repository':'owner/repo','repositoryNodeId':'R_123','target':'main','credentialRef':'test'}})\nseen={}\ndef capture(argv,**kw):\n seen['argv']=argv;seen['proxy']=kw['env'].get('GIT_CONFIG_VALUE_1');return b'ok'\nns['subprocess'].check_output=capture\npublisher.git('ls-remote','https://github.com/owner/repo.git',network=True)\nprint(json.dumps(seen))`,
  );
  assert.equal(r.proxy, "socks5h://127.0.0.1:41080");
  assert.ok(!JSON.stringify(r.argv).includes("synthetic-credential"));
});
test("publisher connection proxy rejects remote endpoints and embedded credentials", (t) => {
  const r = python(
    t,
    `root=pathlib.Path(os.environ['HOME'])/'.config/ppeng-factory/publishers';root.mkdir(parents=True);results=[]\nfor proxy in ['socks5h://remote.example:1080','socks5h://user:password@127.0.0.1:1080','socks5h://127.0.0.1:0','socks5h://127.0.0.1:99999']:\n (root/'test.json').write_text(json.dumps({'repository':'owner/repo','repositoryNodeId':'R_123','token':'synthetic-credential','gitProxy':proxy}))\n try:ns['Publisher']({'action':'preflight','policy':{'repository':'owner/repo','repositoryNodeId':'R_123','target':'main','credentialRef':'test'}});results.append(True)\n except ValueError:results.append(False)\nprint(json.dumps(results))`,
  );
  assert.deepEqual(r, [false, false, false, false]);
});
test("merge identity fence covers every non-target branch and has no App/write-role bypass", (t) => {
  const r = python(
    t,
    `publisher=ns['Publisher'].__new__(ns['Publisher']);publisher.p={'target':'main'}\nrule={'target':'branch','enforcement':'active','conditions':{'ref_name':{'include':['~ALL'],'exclude':['refs/heads/main']}},'rules':[{'type':'update'}],'bypass_actors':[{'actor_type':'RepositoryRole','actor_id':5,'bypass_mode':'always'}]}\nresults=[]\nfor patch in [{},{'enforcement':'disabled'},{'conditions':{'ref_name':{'include':['*'],'exclude':['refs/heads/main']}}},{'conditions':{'ref_name':{'include':['~ALL'],'exclude':['refs/heads/main','refs/heads/factory/other']}}},{'bypass_actors':[{'actor_type':'Integration','actor_id':123,'bypass_mode':'always'}]},{'bypass_actors':[{'actor_type':'RepositoryRole','actor_id':3,'bypass_mode':'always'}]}]:\n try:publisher.validate_merge_rules({**rule,**patch});results.append(True)\n except ValueError:results.append(False)\nprint(json.dumps(results))`,
  );
  assert.deepEqual(r, [true, false, false, false, false, false]);
});
test("App JWT signing uses a private reference and produces a valid short-lived RS256 signature", (t) => {
  const r = python(
    t,
    `import subprocess\nroot=pathlib.Path(os.environ['HOME']);key=root/'test.pem'\nsubprocess.run(['openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out',str(key)],check=True,stderr=subprocess.DEVNULL);os.chmod(key,0o600)\npublisher=ns['Publisher'].__new__(ns['Publisher']);publisher.directory=root\njwt=publisher.app_jwt({'appId':123,'privateKey':key.read_text()})\nheader,payload,signature=jwt.split('.')\ndecode=lambda text:ns['base64'].urlsafe_b64decode(text+'='*((-len(text))%4))\n(root/'message').write_bytes((header+'.'+payload).encode());(root/'signature').write_bytes(decode(signature));pub=root/'public.pem'\nsubprocess.run(['openssl','pkey','-in',str(key),'-pubout','-out',str(pub)],check=True,stderr=subprocess.DEVNULL)\nverified=subprocess.run(['openssl','dgst','-sha256','-verify',str(pub),'-signature',str(root/'signature'),str(root/'message')],stdout=subprocess.DEVNULL).returncode==0\nprint(json.dumps({'verified':verified,'header':json.loads(decode(header)),'payload':json.loads(decode(payload))}))`,
  );
  assert.equal(r.verified, true);
  assert.equal(r.header.alg, "RS256");
  assert.equal(r.payload.iss, 123);
  assert.ok(r.payload.exp - r.payload.iat <= 600);
});
test("merge installation token is bounded to one exact repository and refuses expanded permissions [AC:multi-machine-controlled-delivery#AC-24]", (t) => {
  const r = python(
    t,
    `import copy,time\np=ns['Publisher'].__new__(ns['Publisher']);p.p={'repositoryNodeId':'R_123','mergeIdentity':{'installationId':456}};p.merge_jwt='synthetic-jwt';p.merge_repository_id=100\nvalid={'token':'synthetic-installation-token','expires_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(time.time()+3600)),'permissions':{'contents':'write','pull_requests':'write','metadata':'read'}}\nresults=[];requests=[]\nfor case in ['valid','admin','multi','wrong-id','wrong-node','expired','too-long']:\n token=copy.deepcopy(valid);scope={'total_count':1,'repositories':[{'id':100,'node_id':'R_123'}]}\n if case=='admin':token['permissions']['administration']='write'\n if case=='multi':scope['total_count']=2\n if case=='wrong-id':scope['repositories'][0]['id']=101\n if case=='wrong-node':scope['repositories'][0]['node_id']='R_other'\n if case in ['expired','too-long']:token['expires_at']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(time.time()+(-60 if case=='expired' else 7200)))\n def api(path,credential,*args):\n  if path.endswith('/access_tokens'):requests.append(args[1]);return token\n  assert credential=='synthetic-installation-token';return scope\n p.app_api=api\n try:results.append(p.merge_token()=='synthetic-installation-token')\n except ValueError:results.append(False)\nprint(json.dumps({'results':results,'requests':requests}))`,
  );
  assert.deepEqual(r.results, [true, false, false, false, false, false, false]);
  assert.ok(
    r.requests.every(
      (request) =>
        JSON.stringify(request) ===
        JSON.stringify({
          repository_ids: [100],
          permissions: { contents: "write", pull_requests: "write" },
        }),
    ),
  );
});
test("merge App mint failure cannot fall back to the owner publication credential [AC:multi-machine-controlled-delivery#AC-24]", (t) => {
  const r = python(
    t,
    `p=ns['Publisher'].__new__(ns['Publisher']);p.p={'repositoryNodeId':'R_123','mergeIdentity':{'installationId':456}};p.merge_jwt='synthetic-jwt';p.merge_repository_id=100;p.key='owner-credential'\nseen=[]\ndef api(path,credential,*args):\n seen.append(credential);raise ns['PublisherRefusal']('App unavailable')\np.app_api=api\ntry:p.merge_token();accepted=True\nexcept ValueError:accepted=False\nprint(json.dumps({'accepted':accepted,'ownerUsed':p.key in seen,'calls':len(seen)}))`,
  );
  assert.deepEqual(r, { accepted: false, ownerUsed: false, calls: 1 });
});
