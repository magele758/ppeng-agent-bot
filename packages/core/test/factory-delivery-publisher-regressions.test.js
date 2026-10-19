import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Exercise the actual source, including its top-level exception/journal handler.
// No credentials, SSH, GitHub requests or candidate programs are used.
const moduleSource = readFileSync(
  new URL("../src/factory/delivery-worker.ts", import.meta.url),
  "utf8",
);
const source = moduleSource.slice(
  moduleSource.indexOf("String.raw`") + "String.raw`".length,
  moduleSource.lastIndexOf("`;"),
);
const entry = source.indexOf("req=json.load(sys.stdin)");
assert.ok(entry > 0, "publisher entry point must be extracted");
const setup = String.raw`
import io,contextlib
root=pathlib.Path(os.environ['HOME'])
request={'action':'merge','taskId':'factory_test','operationId':'11111111-1111-1111-1111-111111111111','sha':'a'*40,'baseSha':'b'*40,'branch':'factory/factory_test','requirement':'ordinary task','acceptance':[]}
policy={'repository':'owner/repo','repositoryNodeId':'R_123','target':'main','operations':['push','pr','merge'],'requiredChecks':[{'workflowId':1,'job':'test','appId':2}],'maxRetries':0}
facts={'atomicTarget':True,'downstreamSafe':True,'ciConfigurationConfirmed':True,'deletesBranchOnMerge':False,'strict':True,'protected':True,'baseSha':'b'*40,'headSha':'a'*40,'reviewApproved':True,'mergeable':True,'ciRetryExceeded':False,'pr':{'number':1,'state':'open','head':'a'*40,'marker':'factory_test','base':'main','branch':'factory/factory_test'},'checks':[{'workflowId':1,'job':'test','appId':2,'trusted':True,'sha':'a'*40,'baseSha':'b'*40,'runId':1,'attempt':1,'conclusion':'success','status':'completed'}]}
calls=[]
def fake_init(self,r):
 self.r=r;self.p=policy;self.task=r['taskId'];self.repo='owner/repo';self.root=root;self.directory=root;self.key='synthetic-publisher-credential'
Publisher.__init__=fake_init
Publisher.facts=lambda self:facts
Publisher.merge_token=lambda self:'synthetic-app-installation-token'
def recording_api(self,*args,**kwargs):
 calls.append(args)
 return {}
Publisher.api=recording_api
`;

function python(t, body, { entryPoint = false } = {}) {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), "publisher-regression-")),
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const program =
    source.slice(0, entry) +
    setup +
    body +
    (entryPoint
      ? `
sys.stdin=io.StringIO(json.dumps(request))
with contextlib.redirect_stdout(io.StringIO()):
 exec(${JSON.stringify(source.slice(entry))})
journals=[json.loads(p.read_text()) for p in root.glob('operation-*.json')]
print(json.dumps({'calls':calls,'journals':journals}))
`
      : `
p=Publisher(request)
try:p.execute()
except PublisherRefusal:pass
print(json.dumps({'calls':calls}))
`);
  const result = spawnSync("python3", ["-I", "-c", program], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("publisher refuses a PR retargeted after coordinator validation [AC:multi-machine-controlled-delivery#AC-24]", (t) => {
  const result = python(t, "facts['pr']['base']='another-branch'\n");
  assert.deepEqual(
    result.calls,
    [],
    "unauthorized target must never reach merge PUT",
  );
});

test("publisher rejects successful CI from a stale target baseline [AC:multi-machine-controlled-delivery#AC-19]", (t) => {
  const result = python(t, "facts['checks'][0]['baseSha']='c'*40\n");
  assert.deepEqual(result.calls, [], "old-base green must not authorize merge");
});

test("publisher rejects CI success beyond the approved retry budget [AC:multi-machine-controlled-delivery#AC-21]", (t) => {
  const result = python(
    t,
    "facts['ciRetryExceeded']=True\nfacts['checks'][0]['attempt']=2\n",
  );
  assert.deepEqual(
    result.calls,
    [],
    "exhausted CI retries must not authorize merge",
  );
});

test("request sent then timed out cannot journal a conclusively completed writer [AC:multi-machine-controlled-delivery#AC-11]", (t) => {
  const result = python(
    t,
    String.raw`
request['action']='pr';facts['pr']=None
# Use the actual HTTP request code with an in-memory transport that reports
# a read timeout after accepting the outgoing request; nothing leaves Python.
exec(${JSON.stringify(source.slice(0, entry))}, original := {})
Publisher.api=original['Publisher'].api
class TimedOutTransport:
 def open(self,req,timeout):
  calls.append([req.method,req.full_url])
  raise TimeoutError('synthetic read timeout after send')
prior_init=Publisher.__init__
def timed_init(self,r):
 prior_init(self,r);self.opener=TimedOutTransport()
Publisher.__init__=timed_init
`,
    { entryPoint: true },
  );
  assert.equal(
    result.calls.length,
    1,
    "the timeout must occur after a write request was sent",
  );
  assert.ok(
    result.journals.every((journal) => journal.completed !== true),
    "transport uncertainty must retain an unresolved writer, not completed:true",
  );
});

test("legacy persisted finished flag cannot override an ambiguous error journal [AC:multi-machine-controlled-delivery#AC-27]", async () => {
  const { FactoryDelivery } = await import("../dist/factory/delivery.js");
  const controller = Object.create(FactoryDelivery.prototype);
  const id = "11111111-1111-1111-1111-111111111111";
  const record = {
    taskId: "factory_test",
    stage: "VERIFYING",
    candidate: "a".repeat(40),
    policy: { maxRetries: 1 },
    attempts: 0,
    // The old implementation persisted this flag for every publisherError,
    // including a transport timeout after a remote request was sent.
    pending: { id, action: "push", sha: "a".repeat(40), finished: true },
  };
  controller.call = async () => ({
    headSha: null,
    pr: null,
    operation: { operationId: id, completed: true, error: true },
  });
  controller.write = () => {};
  controller.event = () => {};
  const result = await controller.reconcile({}, { id: record.taskId }, record);
  assert.equal(result, null, "the prior executor remains unresolved");
  assert.equal(
    record.pending?.id,
    id,
    "legacy uncertainty must retain the same writer",
  );
  assert.equal(record.attempts, 0, "unknown outcome cannot authorize a retry");
});

test("actual merge PUT uses only the separate App token [AC:multi-machine-controlled-delivery#AC-24]", (t) => {
  const result = python(
    t,
    `def app_merge(self,path,method,body,**kwargs):
 assert kwargs.get('credential')=='synthetic-app-installation-token'
 assert kwargs.get('credential')!=self.key
 calls.append([path,method,body])
 return {}
Publisher.api=app_merge
`,
  );
  assert.deepEqual(result.calls, [
    ["pulls/1/merge", "PUT", { sha: "a".repeat(40), merge_method: "squash" }],
  ]);
});
test("mint refusal leaves the merge writer unopened and has no owner fallback [AC:multi-machine-controlled-delivery#AC-24]", (t) => {
  const result = python(
    t,
    `def refuse(self):raise PublisherRefusal('App unavailable')
Publisher.merge_token=refuse
`,
  );
  assert.deepEqual(result.calls, []);
});
