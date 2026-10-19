import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { FACTORY_WORKER } from "../dist/factory/transport.js";
import { sanitizeSpawnEnv } from "../dist/sandbox/env-sanitizer.js";
function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "factory-worker-"))),
    repo = join(home, "repo");
  mkdirSync(repo);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], {
      env: sanitizeSpawnEnv({ stripCredentials: true }),
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  for (const name of ["a", "b", "c"]) writeFileSync(join(repo, name), name);
  git("add", ".");
  git(
    "-c",
    "user.name=Factory Test",
    "-c",
    "user.email=factory@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  let seq = 0;
  const task = (operation) => ({
    id: "factory_test_" + ++seq,
    repositoryPath: repo,
    operation,
    timeoutMs: 10000,
  });
  const run = (action, job, extra = {}) => {
    const result = spawnSync("python3", ["-I", "-c", FACTORY_WORKER], {
      input: JSON.stringify({ action, task: job, ...extra }),
      encoding: "utf8",
      timeout: 20000,
      env: sanitizeSpawnEnv({
        stripCredentials: true,
        overrides: { HOME: home },
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { home, repo, git, task, run };
}
test("actual Python worker counts NUL-separated files and never replays an accepted task [AC:multi-machine-readonly-pilot#AC-4] [AC:multi-machine-readonly-pilot#AC-6]", (t) => {
  const f = fixture(t),
    job = f.task("count-files"),
    head = f.git("rev-parse", "HEAD"),
    before = f.git("status", "--porcelain");
  const first = f.run("start", job);
  assert.equal(first.status, "succeeded");
  assert.equal(first.result.count, 3);
  assert.equal(first.result.sha, head);
  assert.equal(f.run("start", job).result.count, 3);
  assert.equal(f.run("status", job).result.count, 3);
  assert.equal(f.git("status", "--porcelain"), before);
});
test("actual Python worker only reads bounded configured regular logs and refuses mutations [AC:multi-machine-readonly-pilot#AC-7]", (t) => {
  const f = fixture(t);
  const log = join(f.home, "output.log");
  writeFileSync(log, "x".repeat(20000));
  const good = f.run("start", f.task("read-log"), { logPath: log });
  assert.equal(good.result.log.length, 16384);
  const link = join(f.home, "link.log");
  symlinkSync(log, link);
  assert.equal(
    f.run("start", f.task("read-log"), { logPath: link }).status,
    "failed",
  );
  assert.equal(
    f.run("start", f.task("read-log"), { logPath: join(f.home, ".env") })
      .status,
    "failed",
  );
  assert.equal(f.run("start", f.task("push")).status, "failed");
  assert.equal(readFileSync(log, "utf8").length, 20000);
});

test("SSH transport rejects malformed or unverified completion receipts before persistence", async () => {
  const { SshFactoryTransport } = await import("../dist/factory/transport.js");
  const transport = new SshFactoryTransport();
  const machine = { sshAlias: "test", repositories: [] };
  for (const receipt of [
    { status: "succeeded", seq: 2, finished: true },
    {
      status: "succeeded",
      seq: 2,
      identity: "host",
      finished: true,
      result: { sha: 123 },
    },
    {
      status: "failed",
      seq: 2,
      identity: "host",
      finished: true,
      error: { secret: "not-a-string" },
    },
    { status: "running", seq: NaN, identity: "host" },
  ]) {
    transport.invoke = async () => receipt;
    await assert.rejects(transport.start(machine, {}), /receipt/i);
  }
  transport.invoke = async () => ({
    status: "succeeded",
    seq: 2,
    identity: "host",
    finished: true,
    result: { sha: "a".repeat(40), branch: "main", path: "/repo" },
  });
  assert.equal((await transport.start(machine, {})).result.branch, "main");
  await transport.close();
});
test('verified developer cancellation receipt is accepted but unfinished cancellation rejected',async()=>{const {SshFactoryTransport}=await import('../dist/factory/transport.js');const transport=new SshFactoryTransport();const machine={sshAlias:'test',repositories:[]};const task={development:{generation:1}};transport.invoke=async()=>({status:'cancelled',seq:3,identity:'host',finished:true,result:{development:{generation:1,stage:'CANCELLED'}}});assert.equal((await transport.stop(machine,task,'cancel')).status,'cancelled');transport.invoke=async()=>({status:'cancelled',seq:3,identity:'host',finished:false});await assert.rejects(transport.stop(machine,task,'cancel'),/receipt/i);await transport.close();});
test('dependency transfer verifies digest and never imports corrupt data',async()=>{const{createHash}=await import('node:crypto');const{SshFactoryTransport}=await import('../dist/factory/transport.js');const transport=new SshFactoryTransport();const data=Buffer.from('bounded trusted bundle');const artifact={sha:'a'.repeat(40),baseline:'b'.repeat(40),digest:createHash('sha256').update(data).digest('hex'),bytes:data.length,base64:data.toString('base64')};const source={machine:{sshAlias:'source'},development:{generation:1}};const target={development:{generation:1,dependency:{sha:artifact.sha}}};const calls=[];transport.invoke=async(machine,action,task,extra)=>{calls.push({machine,action,extra});return action==='artifact'?artifact:{sha:artifact.sha,digest:artifact.digest,bytes:artifact.bytes};};const result=await transport.prepareDependency({sshAlias:'target'},target,source);assert.equal(result.sha,artifact.sha);assert.deepEqual(calls.map(c=>c.action),['artifact','import-artifact']);assert.equal(calls[1].extra.artifact.base64,artifact.base64);calls.length=0;artifact.digest='c'.repeat(64);await assert.rejects(transport.prepareDependency({sshAlias:'target'},target,source),/artifact/i);assert.equal(calls.length,1);await transport.close();});
test('status wire excludes previous outputs and execution history',async t=>{const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const dir=mkdtempSync(join(tmpdir(),'factory-wire-'));const bin=join(dir,'bin');mkdirSync(bin);const capture=join(dir,'request.json');writeFileSync(join(bin,'ssh'),'#!/usr/bin/python3\nimport sys,json,pathlib\nv=json.load(sys.stdin);pathlib.Path('+JSON.stringify(capture)+').write_text(json.dumps(v));print(json.dumps({"status":"running","seq":1,"identity":"host","result":{"development":{"generation":1,"stage":"DEV"}}}))\n',{mode:0o755});const old=process.env.PATH;process.env.PATH=bin+':'+old;t.after(()=>{process.env.PATH=old;rmSync(dir,{recursive:true,force:true});});const{SshFactoryTransport}=await import('../dist/factory/transport.js');const transport=new SshFactoryTransport();t.after(()=>transport.close());await transport.status({sshAlias:'test',repositories:[]},{id:'factory_test',repositoryPath:'/repo',identity:'host',result:{old:'previous-output'},history:['private-history'],development:{generation:1,executions:[{private:'prior-execution'}],decisions:[{private:'old-decision'}]}});const sent=readFileSync(capture,'utf8');assert.ok(!sent.includes('previous-output'));assert.ok(!sent.includes('prior-execution'));assert.ok(!sent.includes('old-decision'));assert.equal(JSON.parse(sent).task.development.generation,1);});
