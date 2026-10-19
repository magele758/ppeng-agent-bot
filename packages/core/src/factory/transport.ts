import { DELIVERY_WORKER } from "./delivery-worker.js";
import type { DeliveryRequest } from "./delivery-types.js";
import { createHash } from "node:crypto";
import { DEVELOPMENT_WORKER } from "./development-worker.js";
import type { DevelopmentPolicy, DevelopmentPreflight } from "./development-types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeSpawnEnv } from "../sandbox/env-sanitizer.js";
import {
  terminateProcessTree,
  treeKillSpawnOptions,
} from "../sandbox/process-tree.js";
import type {
  FactoryMachine,
  FactoryReport,
  FactorySignals,
  FactoryTask,
  FactoryTransport,
} from "./types.js";

/** Fixed Python program, isolated interpreter, JSON input. No user supplied shell commands.
 * Remote writes are confined to the factory receipt directory. Receipts survive SSH loss.
 * flock makes repeated start requests return the original execution, across daemon processes.
 */
export const FACTORY_WORKER = String.raw`
import os, sys, json, time, socket, hashlib, subprocess, pathlib, fcntl, stat
req=json.load(sys.stdin)
def identity():
    try: value=pathlib.Path('/etc/machine-id').read_text().strip()
    except OSError: value=socket.gethostname()+str(pathlib.Path.home())
    return hashlib.sha256(value.encode()).hexdigest()
ident=identity()
def emit(value):
    print(json.dumps(value,ensure_ascii=False),flush=True)
if req['action']=='probe':
    emit({'identity':ident,'hostname':socket.gethostname()});sys.exit(0)
id=req['task']['id']
if not id.startswith('factory_') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in id):
    raise ValueError('Invalid task id')
root=pathlib.Path.home()/'.local'/'state'/'ppeng-factory'
root.mkdir(parents=True,exist_ok=True,mode=0o700)
if root.is_symlink() or root.stat().st_uid!=os.getuid(): raise ValueError('Invalid receipt directory')
directory=root/id
directory.mkdir(exist_ok=True,mode=0o700)
if directory.is_symlink(): raise ValueError('Invalid task directory')
record=directory/'receipt.json'
def save(value):
    tmp=directory/('receipt-'+str(os.getpid())+'.tmp')
    with open(tmp,'w') as f: json.dump(value,f)
    os.replace(tmp,record)
def read():
    try: return json.loads(record.read_text())
    except (OSError,ValueError): return None
def token(pid):
    try: return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().split()[21]
    except (OSError,IndexError): return None
def alive(r):
    try:
        os.kill(r.get('pid',-1),0)
        return r.get('processToken') is not None and token(r['pid'])==r['processToken']
    except OSError: return False
current=read()
if req['action']=='status':
    if current and current['status']=='running' and not alive(current):
        current={**current,'status':'unknown','error':'Worker exited without a verified result','seq':current.get('seq',1)}
    emit(current or {'status':'unknown','seq':1,'identity':ident,'error':'No receipt: do not replay automatically'});sys.exit(0)
if req['action']=='inspect':
    running=bool(current and current['status']=='running' and alive(current))
    cpu=None
    if running:
        try: cpu=float(subprocess.check_output(['ps','-p',str(current['pid']),'-o','%cpu='],timeout=3,text=True).strip())
        except Exception: pass
    commit=None
    fresh=bool(current and time.time()-current.get('at',0)<3600)
    try:
        env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(pathlib.Path.home()),'GIT_OPTIONAL_LOCKS':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}
        git=['git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',req['task']['repositoryPath']]
        commit=subprocess.check_output(git+['rev-parse','HEAD'],env=env,stderr=subprocess.PIPE,timeout=3,text=True).strip()
        committed=int(subprocess.check_output(git+['log','-1','--format=%ct'],env=env,stderr=subprocess.PIPE,timeout=3,text=True).strip())
        fresh=fresh or time.time()-committed<3600
    except Exception: pass
    emit({'process':running,'fresh':fresh,'commit':commit,'cpu':cpu});sys.exit(0)
if req['action']!='start': raise ValueError('Invalid action')
# Never inherit model/gateway credentials into git or ps processes.
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(pathlib.Path.home()),'LANG':'C.UTF-8','GIT_OPTIONAL_LOCKS':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0'}
with open(directory/'lock','a') as lock:
    try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        emit(read() or {'status':'unknown','seq':1,'identity':ident});sys.exit(0)
    prior=read()
    if prior:
        emit(prior);sys.exit(0)
    task=req['task']; started=time.time(); timeout=task['timeoutMs']/1000
    state={'status':'running','seq':1,'identity':ident,'pid':os.getpid(),'processToken':token(os.getpid()),'at':started}
    save(state)
    def git(*args):
        left=max(.01,timeout-(time.time()-started))
        return subprocess.check_output(['git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.pager=cat','-C',task['repositoryPath'],*args],env=env,stderr=subprocess.PIPE,timeout=left).decode('utf-8','replace').strip()
    try:
        if task['operation'] not in ('snapshot','count-files','read-log'): raise ValueError('Read-only operation required')
        result={'path':str(pathlib.Path(task['repositoryPath']).resolve()),'branch':git('rev-parse','--abbrev-ref','HEAD'),'sha':git('rev-parse','HEAD')}
        if task['operation']=='count-files':
            result['count']=len([x for x in git('ls-files','-z').split('\0') if x])
        if task['operation']=='read-log':
            log=pathlib.Path(req['logPath'])
            denied=('.env','id_rsa','id_ed25519','credentials','secret','token','.pem','.key')
            if not log.is_absolute() or any(any(word in part.lower() for word in denied) for part in log.parts): raise ValueError('Sensitive log path refused')
            # Refuse symlinks and special files; tail at most 16KiB of the configured file.
            if any(p.is_symlink() for p in [log,*log.parents]): raise ValueError('Symlink log path refused')
            fd=os.open(str(log),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            with os.fdopen(fd,'rb') as f:
                if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise ValueError('Regular log file required')
                f.seek(max(0,os.fstat(f.fileno()).st_size-16384));result['log']=f.read(16384).decode('utf-8','replace')
        state={**state,'status':'succeeded','seq':2,'finished':True,'result':result,'at':time.time()}
    except subprocess.TimeoutExpired:
        state={**state,'status':'timed_out','seq':2,'finished':True,'error':'Read-only operation exceeded deadline','at':time.time()}
    except Exception as e:
        state={**state,'status':'failed','seq':2,'finished':True,'error':type(e).__name__+': read-only operation failed; verify repository or configured log','at':time.time()}
    save(state);emit(state)
`;
const bootstrap = `import base64;exec(base64.b64decode('${Buffer.from(FACTORY_WORKER).toString("base64")}'))`;
const REPORT_STATES = new Set([
  "running",
  "unknown",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);
function verifiedReport(value: unknown, development = false): FactoryReport {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid remote receipt");
  const r = value as Record<string, unknown>;
  if (
    !REPORT_STATES.has(String(r.status)) ||
    !Number.isSafeInteger(r.seq) ||
    Number(r.seq) < 1 ||
    typeof r.identity !== "string" ||
    !r.identity ||
    (r.error !== undefined && typeof r.error !== "string")
  )
    throw new Error("Invalid remote receipt");
  if (
    ["succeeded", "failed", "timed_out", "cancelled"].includes(String(r.status)) &&
    r.finished !== true
  )
    throw new Error("Unverified remote receipt");
  if (r.status === "succeeded" && !development) {
    const result = r.result as Record<string, unknown> | undefined;
    if (
      !result ||
      typeof result !== "object" ||
      typeof result.sha !== "string" ||
      !/^[a-f0-9]{40,64}$/.test(result.sha) ||
      typeof result.branch !== "string" ||
      typeof result.path !== "string"
    )
      throw new Error("Invalid completed receipt");
  }
  return value as FactoryReport;
}
export class SshFactoryTransport implements FactoryTransport {
  private children = new Set<ChildProcess>();
  private invoke(
    machine: FactoryMachine,
    action: string,
    task?: FactoryTask,
    extra?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(machine.sshAlias))
      return Promise.reject(new Error("Invalid SSH alias"));
    if (task?.development?.reviewCarry && Buffer.byteLength(JSON.stringify(task.development.reviewCarry),"utf8") > 262144)
      return Promise.reject(new Error("Review summary exceeds continuation budget; recovery required"));
    return new Promise((resolve, reject) => {
      const repo = machine.repositories.find(
          (r) => r.id === task?.repositoryId,
        ),
        logPath = repo?.logs?.find((l) => l.id === task?.logId)?.path;
      const program = action === "delivery" ? `import base64;exec(base64.b64decode('${Buffer.from(DELIVERY_WORKER).toString("base64")}'))` : task?.development || action === "preflight" ? `source=__import__('base64').b64decode('${Buffer.from(DEVELOPMENT_WORKER).toString("base64")}').decode();globals()['_SOURCE']=source;exec(source)` : bootstrap;
      const child = spawn(
        "ssh",
        [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ServerAliveInterval=5",
          "-o",
          "ServerAliveCountMax=2",
          "--",
          machine.sshAlias,
          `python3 -I -c "${program}"`,
        ],
        {
          env: sanitizeSpawnEnv({ stripCredentials: true }),
          stdio: ["pipe", "pipe", "pipe"],
          ...treeKillSpawnOptions(),
        },
      );
      this.children.add(child);
      let output = "";
      let done = false;
      const end = (err?: Error, value?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.children.delete(child);
        err ? reject(err) : resolve(value);
      };
      const timer = setTimeout(
        () => {
          terminateProcessTree(child);
          end(new Error("SSH response unavailable; verify remote receipt"));
        },
        action === "delivery" ? 120000 : action === "preflight" ? 90000 : action === "start" ? Math.max(90000,(task?.timeoutMs ?? 30000) + 15000) : action === "stop" ? 25000 : 15000,
      );
      child.stdout?.on("data", (part) => {
        output += part.toString();
        if (output.length > (task?.development || action === "artifact" ? 2097152 : 131072)) {
          terminateProcessTree(child);
          end(new Error("Remote result exceeds limit"));
        }
      });
      child.stderr?.on("data", () => {});
      child.on("error", () => end(new Error("SSH connection unavailable")));
      child.on("close", (code) => {
        if (code !== 0) return end(new Error("SSH connection unavailable"));
        try {
          const parsed = JSON.parse(output);
          if (!parsed || typeof parsed !== "object") throw Error();
          end(undefined, parsed);
        } catch {
          end(new Error("Invalid remote receipt"));
        }
      });
      child.stdin?.on("error", () => {});
      const wireTask = task?.development ? {id:task.id,identity:task.identity,repositoryPath:task.repositoryPath,principal:task.principal,machineId:task.machineId,
        development:{requirement:task.development.requirement,baseline:task.development.baseline,policy:task.development.policy,generation:task.development.generation,round:task.development.round,dependency:task.development.dependency,reviewCarry:task.development.reviewCarry,deliveryInput:task.development.deliveryInput,verifyCurrent:task.development.verifyCurrent}} : task;
      child.stdin?.end(JSON.stringify({ action, task:wireTask, logPath, ...extra }));
    });
  }
  async delivery(m:FactoryMachine,request:DeliveryRequest,t?:FactoryTask){
    const result=await this.invoke(m,"delivery",t,request) as any;
    if(result?.publisherError){const error=Object.assign(new Error("Publisher refused operation: "+result.detail),{publisherFinished:result.publisherFinished===true,publisherRefused:result.publisherError==="PublisherRefusal"&&result.publisherFinished===true,action:request.action});throw error;}return result;
  }
  async probe(m: FactoryMachine) {
    const r = (await this.invoke(m, "probe")) as {
      identity: string;
      hostname: string;
    };
    if (
      typeof r.identity !== "string" ||
      !r.identity ||
      typeof r.hostname !== "string"
    )
      throw new Error("Invalid remote identity");
    return r;
  }
  async start(m: FactoryMachine, t: FactoryTask) {
    return verifiedReport(await this.invoke(m, "start", t), !!t.development);
  }
  async status(m: FactoryMachine, t: FactoryTask) {
    return verifiedReport(await this.invoke(m, "status", t), !!t.development);
  }
  async inspect(m: FactoryMachine, t: FactoryTask) {
    return this.invoke(m, "inspect", t) as Promise<FactorySignals>;
  }
  async preflight(m: FactoryMachine, policy: DevelopmentPolicy, baseline: string): Promise<DevelopmentPreflight> {
    const r = await this.invoke(m,"preflight",undefined,{policy,baseline,repositoryPath:m.repositories[0]?.path}) as DevelopmentPreflight;
    if(typeof r?.ready!=="boolean" || !Array.isArray(r.checks)) throw Error("Invalid preflight response");
    return r;
  }
  async stop(m: FactoryMachine, t: FactoryTask, action: string) {
    return verifiedReport(await this.invoke(m,"stop",t,{control:action}),true);
  }
  async prepareDependency(m: FactoryMachine, target: FactoryTask, source: FactoryTask) {
    const artifact=await this.invoke(source.machine,"artifact",source,{sha:target.development!.dependency!.sha}) as {sha:string;digest:string;bytes:number;base64:string};
    const bytes=Buffer.from(artifact.base64,"base64");
    if(bytes.length>700000 || bytes.length!==artifact.bytes || createHash("sha256").update(bytes).digest("hex")!==artifact.digest || artifact.sha!==target.development!.dependency!.sha) throw Error("Invalid dependency artifact");
    const result=await this.invoke(m,"import-artifact",target,{artifact}) as {sha:string;digest:string;bytes:number};
    if(result.sha!==artifact.sha || result.digest!==artifact.digest || result.bytes!==artifact.bytes) throw Error("Dependency import receipt mismatch");
    return result;
  }
  async close() {
    for (const child of this.children) terminateProcessTree(child);
    this.children.clear();
  }
}
