import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../discovery/cbom.js';
import { randomUUID, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP, isIPv4 } from 'node:net';
import type { RunContext, ToolContract, ToolExecutionResult } from '../types.js';
import type { ConnectorGrantStore } from './registry.js';
import { ValidationError } from '../errors.js';
import { SecretVault } from '../secrets/secret-vault.js';
import { assertWritableEnvName } from '../secrets/reserved-env-names.js';
import { collectReservedDynToolNames, isReservedDynToolName } from '../dyn-tools/names.js';
import { isPrivateOrReservedIp } from '../goal/run-verify.js';
import { fenceExternalContent } from '../safety/external-content.js';
import { requestApprovedAddress } from './http-request.js';

// Keep aligned with sandbox/env-sanitizer OPERATOR_CHILD_DENY: operator secrets
// must never be selected by a Bot as software credentials, including old bindings.
const OPERATOR_CREDENTIAL_DENY = new Set(['RAW_AGENT_AUTH_TOKEN', 'RAW_AGENT_HUMAN_RELEASE_SECRET']);
function assertSoftwareCredentialName(name: string): void {
  assertWritableEnvName(name);
  if (OPERATOR_CREDENTIAL_DENY.has(name)) throw new ValidationError('Operator credential cannot be used for software execution');
}

export interface HttpExecutor {
  kind: 'http'; url: string; method?: string;
  parameters?: Array<{name: string; in: 'path'|'query'|'header'; required?: boolean}>;
  auth?: {kind: 'bearer'|'header'|'query'; name?: string};
  timeoutMs?: number; maxBytes?: number; idempotencyHeader?: string;
}
export interface McpExecutor { kind: 'mcp'; toolName: string; readOnly?: boolean }
export type SoftwareExecutor = HttpExecutor | McpExecutor;
export interface SoftwareTool {name: string; description: string; inputSchema: Record<string,unknown>; executor: SoftwareExecutor}
export interface SoftwareConnection {
  principal: string; botId: string; connectorId: string; revision?: string; secretEnv?: string; credRef?: string;
  tools: SoftwareTool[]; health: 'configured'|'ready'|'degraded'|'unavailable'; lastProbeAt?: string;
}
export interface Invocation {
  id: string; seq?: number; principal: string; botId: string; connectorId: string; toolName: string; sessionId?: string; taskId?: string;
  fingerprint: string; requestHash?: string; state: 'running'|'completed'|'failed'|'unknown'; write: boolean;
  startedAt: string; finishedAt?: string; result?: ToolExecutionResult; error?: string;
}
const CONNECTIONS = 'software_connections_v1';
const INVOCATIONS = 'software_invocations_v1';
/** Indexed, append-preserving ledger. Runtime settings stores without SQLite are test adapters. */
export function ensureSoftwareInvocationSchema(store: {db: DatabaseSync}): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS software_invocations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      principal TEXT NOT NULL, bot_id TEXT NOT NULL, connector_id TEXT NOT NULL,
      state TEXT NOT NULL, write_effect INTEGER NOT NULL, session_id TEXT, task_id TEXT,
      request_hash TEXT, fingerprint TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS software_invocations_scope ON software_invocations(principal,bot_id,connector_id,seq DESC);
    CREATE INDEX IF NOT EXISTS software_invocations_state ON software_invocations(state,seq);
    CREATE INDEX IF NOT EXISTS software_invocations_request ON software_invocations(request_hash,state,write_effect);
    CREATE INDEX IF NOT EXISTS software_invocations_session ON software_invocations(session_id,state,started_at);
    CREATE INDEX IF NOT EXISTS software_invocations_task ON software_invocations(task_id,state);
  `);
}
export interface InvocationPageOptions {limit?:number;beforeSeq?:number}
class InvocationLedger {
  private readonly db?: DatabaseSync;
  constructor(private readonly store: ConnectorGrantStore) {
    this.db=(store as ConnectorGrantStore & {db?:DatabaseSync}).db;
    if(!this.db)return;
    ensureSoftwareInvocationSchema({db:this.db});
    if(store.getDaemonControl<boolean>('software_invocations_sql_migrated_v1'))return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=store.getDaemonControl<Invocation[]>(INVOCATIONS)??[];
      for(const row of old) {
        if(!this.get(row.id))this.put(row);
      }
      store.setDaemonControl('software_invocations_sql_migrated_v1',true);
      // The evidence has moved to individually indexed rows, never truncated.
      store.setDaemonControl(INVOCATIONS,[]);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  private decode(row:unknown):Invocation|undefined {
    if(!row)return undefined;
    const value=row as {payload:string;seq:number};return {...JSON.parse(value.payload),seq:value.seq} as Invocation;
  }
  put(row:Invocation):void {
    if(this.db) {
      this.db.prepare(`INSERT INTO software_invocations(id,principal,bot_id,connector_id,state,write_effect,session_id,task_id,request_hash,fingerprint,started_at,payload)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,request_hash=excluded.request_hash,payload=excluded.payload`).run(
          row.id,row.principal,row.botId,row.connectorId,row.state,row.write?1:0,row.sessionId??null,row.taskId??null,row.requestHash??null,row.fingerprint,row.startedAt,JSON.stringify(row));
      return;
    }
    const rows=this.store.getDaemonControl<Invocation[]>(INVOCATIONS)??[];
    const index=rows.findIndex(r=>r.id===row.id);if(index<0)rows.push(row);else rows[index]=row;
    this.store.setDaemonControl(INVOCATIONS,rows);
  }
  get(id:string):Invocation|undefined {
    return this.db?this.decode(this.db.prepare('SELECT payload,seq FROM software_invocations WHERE id=?').get(id)):(this.store.getDaemonControl<Invocation[]>(INVOCATIONS)??[]).find(r=>r.id===id);
  }
  fingerprint(hash:string):Invocation|undefined {
    return this.db?this.decode(this.db.prepare('SELECT payload,seq FROM software_invocations WHERE fingerprint=?').get(hash)):(this.store.getDaemonControl<Invocation[]>(INVOCATIONS)??[]).find(r=>r.fingerprint===hash);
  }
  uncertain(hash:string):Invocation|undefined {
    return this.db?this.decode(this.db.prepare("SELECT payload,seq FROM software_invocations WHERE request_hash=? AND state IN ('running','unknown') AND write_effect=1 ORDER BY seq LIMIT 1").get(hash)):(this.store.getDaemonControl<Invocation[]>(INVOCATIONS)??[]).find(r=>r.requestHash===hash&&r.write&&['running','unknown'].includes(r.state));
  }
  list(principal?:string,botId?:string,connectorId?:string,opts:InvocationPageOptions={}):Invocation[] {
    const limit=opts.limit??100;
    if(!Number.isInteger(limit)||limit<1||limit>500||opts.beforeSeq!==undefined&&(!Number.isInteger(opts.beforeSeq)||opts.beforeSeq<1))throw new ValidationError('Invalid invocation page');
    if(this.db) {
      const where:string[]=[],values:Array<string|number>=[];
      for(const [column,value] of [['principal',principal],['bot_id',botId],['connector_id',connectorId]] as const)if(value!==undefined){where.push(column+'=?');values.push(value);}
      if(opts.beforeSeq!==undefined){where.push('seq<?');values.push(opts.beforeSeq);}
      values.push(limit);
      return this.db.prepare(`SELECT payload,seq FROM software_invocations${where.length?' WHERE '+where.join(' AND '):''} ORDER BY seq DESC LIMIT ?`).all(...values).map(row=>this.decode(row)!);
    }
    return (this.store.getDaemonControl<Invocation[]>(INVOCATIONS)??[]).map((r,i)=>({...r,seq:i+1})).filter(r=>(principal===undefined||r.principal===principal)&&(botId===undefined||r.botId===botId)&&(connectorId===undefined||r.connectorId===connectorId)&&(opts.beforeSeq===undefined||r.seq<opts.beforeSeq)).reverse().slice(0,limit);
  }
  unconfirmed(sessionId:string,afterStartedAt?:string):Invocation[] {
    if(this.db)return this.db.prepare(`SELECT payload,seq FROM software_invocations WHERE session_id=? AND state='unknown' AND write_effect=1${afterStartedAt?' AND started_at>=?':''} ORDER BY seq`).all(...(afterStartedAt?[sessionId,afterStartedAt]:[sessionId])).map(row=>this.decode(row)!);
    return (this.store.getDaemonControl<Invocation[]>(INVOCATIONS)??[]).filter(r=>r.sessionId===sessionId&&r.write&&r.state==='unknown'&&(!afterStartedAt||r.startedAt>=afterStartedAt));
  }
  recover():void {
    const running=this.db?this.db.prepare("SELECT payload,seq FROM software_invocations WHERE state='running'").all().map(r=>this.decode(r)!):(this.store.getDaemonControl<Invocation[]>(INVOCATIONS)??[]).filter(r=>r.state==='running');
    for(const row of running){row.state='unknown';row.error='Runtime interrupted; verify the external result before retrying';this.put(row);}
  }
}

export function softwarePrincipal(ctx: RunContext): string {
  return JSON.stringify([String(ctx.session.metadata?.tenantId ?? ''), String(ctx.session.metadata?.userId ?? 'installation')]);
}
const connectionKey = (principal:string,botId:string,id:string) => JSON.stringify([principal,botId,id]);
const SOFTWARE_CONNECTION_TOOL = Symbol.for('ppeng.softwareConnectionTool');

function markSoftwareConnectionTool<T extends object>(tool: T): T {
  Object.defineProperty(tool, SOFTWARE_CONNECTION_TOOL, { value: true });
  return tool;
}

function isSoftwareConnectionTool(tool: object): boolean {
  return (tool as { [SOFTWARE_CONNECTION_TOOL]?: true })[SOFTWARE_CONNECTION_TOOL] === true;
}

/** URL canonicalizes IPv4-mapped addresses to hex, so judge the embedded IPv4. */
function embeddedIpv4(ip: string): string | undefined {
  const bare = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (!bare.startsWith('::ffff:')) return undefined;
  const rest = bare.slice('::ffff:'.length);
  if (isIPv4(rest)) return rest;
  const parts = rest.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  const hi = Number.parseInt(parts[0] ?? '', 16);
  const lo = Number.parseInt(parts[1] ?? '', 16);
  const value = ((hi << 16) | lo) >>> 0;
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function privateAddress(ip: string): boolean {
  const embedded = embeddedIpv4(ip);
  if (isPrivateOrReservedIp(embedded ?? ip)) return true;
  const s = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (s.includes(':')) return s === '::';
  const first = Number(s.split('.')[0]);
  return Number.isFinite(first) && first >= 224;
}
function redact(text: string, secret?: string): string {
  if (!secret) return text;
  // URL query serialization and JSON serialization can encode a credential echo.
  const variants = new Set([secret, encodeURIComponent(secret), new URLSearchParams({key:secret}).toString().slice(4), JSON.stringify(secret).slice(1,-1)]);
  for (const variant of [...variants].sort((a,b)=>b.length-a.length)) text=text.split(variant).join('[REDACTED]');
  return text;
}
function writeTool(tool:SoftwareTool):boolean {return tool.executor.kind==='mcp' ? true : !['GET','HEAD','OPTIONS'].includes(tool.executor.method??'GET');}
interface ExecutionBinding {principal: string; botId: string; connection: SoftwareConnection; tool: SoftwareTool; secret?: string}
interface PreparedHttpRequest {url: URL; headers: Record<string, string>; body?: string; signal: AbortSignal}
function executionSignal(ctx: RunContext, timeoutMs: number): AbortSignal {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (ctx.abortSignal) signals.push(ctx.abortSignal);
  return AbortSignal.any(signals);
}
function matchesInputType(type: string, value: unknown): boolean {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === type;
}
function validateSoftwareArguments(schema: Record<string, unknown>, args: Record<string, unknown>): string | undefined {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) if (args[String(name)] === undefined) return 'Missing required input ' + String(name);
  const properties = schema.properties as Record<string, {type?: string}> | undefined;
  for (const [name, property] of Object.entries(properties ?? {})) {
    const value = args[name];
    if (value === undefined || !property.type) continue;
    if (!matchesInputType(property.type, value)) return 'Invalid input type ' + name;
  }
  return undefined;
}
function invocationIdentity(binding: ExecutionBinding, args: Record<string, unknown>, key?: string): {requestHash: string; fingerprint: string} {
  const comparable = {...args};
  delete comparable.idempotency_key;
  const executor = binding.tool.executor;
  const target = executor.kind === 'http' ? [executor.method, executor.url] : executor.toolName;
  const prefix = [binding.principal, binding.botId, binding.connection.connectorId, binding.tool.name];
  return {requestHash: createHash('sha256').update(canonicalJson([...prefix, target, comparable])).digest('hex'),
    fingerprint: createHash('sha256').update(JSON.stringify([...prefix, key ?? randomUUID()])).digest('hex')};
}
function httpParameters(executor: HttpExecutor, args: Record<string, unknown>): {url: URL; headers: Record<string, string>; remaining: Record<string, unknown>} {
  let target = executor.url;
  const headers: Record<string, string> = {accept: 'application/json'};
  const remaining = {...args};
  delete remaining.idempotency_key;
  for (const parameter of executor.parameters ?? []) {
    const value = args[parameter.name];
    if (parameter.required && value === undefined) throw new Error(`Missing parameter ${parameter.name}`);
    delete remaining[parameter.name];
    if (value === undefined) continue;
    if (typeof value === 'object') throw new Error('unsupported parameter serialization');
    if (parameter.in === 'path') target = target.replaceAll(`{${parameter.name}}`, encodeURIComponent(String(value)));
    if (parameter.in === 'header') headers[parameter.name] = String(value);
  }
  const url = new URL(target);
  for (const parameter of executor.parameters ?? []) {
    if (parameter.in === 'query' && args[parameter.name] !== undefined) url.searchParams.set(parameter.name, String(args[parameter.name]));
  }
  return {url, headers, remaining};
}
function applyHttpCredential(executor: HttpExecutor, url: URL, headers: Record<string, string>, secret?: string): void {
  if (!secret || !executor.auth) return;
  if (executor.auth.kind === 'bearer') headers.authorization = `Bearer ${secret}`;
  else if (executor.auth.kind === 'header') headers[executor.auth.name ?? 'X-API-Key'] = secret;
  else url.searchParams.set(executor.auth.name ?? 'api_key', secret);
}
function prepareHttpRequest(ctx: RunContext, executor: HttpExecutor, args: Record<string, unknown>, write: boolean, secret?: string, key?: string): PreparedHttpRequest {
  const {url, headers, remaining} = httpParameters(executor, args);
  applyHttpCredential(executor, url, headers, secret);
  if (key && executor.idempotencyHeader) headers[executor.idempotencyHeader] = key;
  const body = write && Object.keys(remaining).length ? JSON.stringify(remaining.body ?? remaining) : undefined;
  if (body) headers['content-type'] = 'application/json';
  return {url, headers, body, signal: executionSignal(ctx, executor.timeoutMs ?? 30000)};
}
async function readHttpResponse(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!reader) return '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {await reader.cancel(); throw new Error('Response exceeds size limit');}
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class SoftwareExecution {
  private readonly ledger:InvocationLedger;
  private invokeMcp?: (name:string,args:Record<string,unknown>,ctx:RunContext)=>Promise<ToolExecutionResult>;
  constructor(private readonly store:ConnectorGrantStore,private readonly env:NodeJS.ProcessEnv=process.env) {
    this.ledger=new InvocationLedger(store);this.ledger.recover();
  }
  principal(owner?: {userId?: string;tenantId?: string}): string {
    let userId=owner?.userId;
    if(!userId){userId=this.store.getDaemonControl<string>('bot.installationPrincipal');if(!userId){userId='installation:'+randomUUID();this.store.setDaemonControl('bot.installationPrincipal',userId);}}
    return JSON.stringify([owner?.tenantId??'',userId]);
  }
  setMcpInvoker(fn:(name:string,args:Record<string,unknown>,ctx:RunContext)=>Promise<ToolExecutionResult>):void {this.invokeMcp=fn;}
  private connections():Record<string,SoftwareConnection> {return this.store.getDaemonControl(CONNECTIONS)??{};}
  invocations(principal?:string,botId?:string,connectorId?:string,opts:InvocationPageOptions={}):Invocation[] {
    return this.ledger.list(principal,botId,connectorId,opts);
  }
  unconfirmedForSession(sessionId:string,afterStartedAt?:string):Invocation[] {return this.ledger.unconfirmed(sessionId,afterStartedAt);}
  resolveInvocation(principal:string,botId:string,connectorId:string,id:string,state:unknown,note:unknown):Invocation {
    if(!['completed','failed'].includes(String(state))||typeof note!=='string'||!note.trim())throw new ValidationError('Explicit verified outcome and note required');
    const row=this.ledger.get(id);
    if(!row||row.principal!==principal||row.botId!==botId||row.connectorId!==connectorId||row.state!=='unknown')throw new ValidationError('Only an unknown invocation can be reconciled');
    row.state=state as 'completed'|'failed';row.finishedAt=new Date().toISOString();
    row.result={ok:row.state==='completed',content:'Manually verified: '+note.slice(0,2000)};this.ledger.put(row);return row;
  }
  list(principal:string,botId:string):SoftwareConnection[] {return Object.values(this.connections()).filter(c=>c.principal===principal&&c.botId===botId);}
  private bindingInput(input: unknown): Partial<SoftwareConnection> & {tools: SoftwareTool[]} {
    const body = input as Partial<SoftwareConnection>;
    if (!body || !Array.isArray(body.tools) || !body.tools.length) throw new ValidationError('tools must contain executable declarations');
    if (body.secretEnv) assertSoftwareCredentialName(body.secretEnv);
    if (body.credRef) assertSoftwareCredentialName(body.credRef.replace(/^vault:/, ''));
    const hasCredential = body.secretEnv || body.credRef;
    if (hasCredential && body.tools.every(tool => tool.executor?.kind === 'mcp')) throw new ValidationError('MCP bindings use existing server credentials; credential overrides unsupported');
    return body as Partial<SoftwareConnection> & {tools: SoftwareTool[]};
  }
  private validateToolName(tool: SoftwareTool, seen: Set<string>): void {
    const reserved = collectReservedDynToolNames();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,64}$/.test(tool.name) || seen.has(tool.name) || isReservedDynToolName(tool.name, reserved) || /^(mcp_|lcu_)/.test(tool.name)) throw new ValidationError('Invalid or duplicate tool name');
    seen.add(tool.name);
  }
  private validateToolCollisions(principal: string, botId: string, connectorId: string, tool: SoftwareTool): void {
    for (const existing of Object.values(this.connections())) {
      for (const prior of existing.tools) {
        const otherConnection = existing.principal === principal && existing.botId === botId && existing.connectorId !== connectorId;
        if (otherConnection && prior.name === tool.name) throw new ValidationError('Tool name already bound to another connection');
        if (prior.name === tool.name && JSON.stringify(prior.inputSchema) !== JSON.stringify(tool.inputSchema)) throw new ValidationError('Same tool name must use the same input schema');
      }
    }
  }
  private validateHttpExecutor(executor: HttpExecutor): void {
    const url = new URL(executor.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ValidationError('Invalid HTTP endpoint');
    executor.method = (executor.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(executor.method)) throw new ValidationError('unsupported HTTP method');
    if (executor.timeoutMs !== undefined && (!Number.isFinite(executor.timeoutMs) || executor.timeoutMs < 1 || executor.timeoutMs > 120000)) throw new ValidationError('timeoutMs outside 1..120000');
    if (executor.maxBytes !== undefined && (!Number.isInteger(executor.maxBytes) || executor.maxBytes < 1 || executor.maxBytes > 2000000)) throw new ValidationError('maxBytes outside 1..2000000');
  }
  private validateExecutor(tool: SoftwareTool): void {
    if (!tool.executor || !['http', 'mcp'].includes(tool.executor.kind)) throw new ValidationError('unsupported executor');
    if (tool.executor.kind === 'http') this.validateHttpExecutor(tool.executor);
    else if (!/^mcp_(?:invoke|[hs]\d+_\S+)$/.test(tool.executor.toolName)) throw new ValidationError('MCP executor must bind an existing MCP tool');
  }
  bind(principal: string, botId: string, connectorId: string, input: unknown): SoftwareConnection {
    const body = this.bindingInput(input);
    const seen = new Set<string>();
    for (const tool of body.tools) {
      this.validateToolName(tool, seen);
      this.validateToolCollisions(principal, botId, connectorId, tool);
      this.validateExecutor(tool);
    }
    const connection: SoftwareConnection = {principal, botId, connectorId, revision: randomUUID(), tools: structuredClone(body.tools), health: 'configured'};
    if (body.secretEnv) connection.secretEnv = body.secretEnv;
    if (body.credRef) connection.credRef = body.credRef;
    const rows = this.connections();
    rows[connectionKey(principal, botId, connectorId)] = connection;
    this.store.setDaemonControl(CONNECTIONS, rows);
    return connection;
  }
  revoke(principal:string,botId:string,connectorId:string):void {const rows=this.connections();delete rows[connectionKey(principal,botId,connectorId)];this.store.setDaemonControl(CONNECTIONS,rows);}
  filterForSession<T extends {name:string}>(tools:T[],session:{metadata?:Record<string,unknown>}):T[] {
    const principal=this.principal({userId:session.metadata?.userId as string|undefined,tenantId:session.metadata?.tenantId as string|undefined});
    const all=new Set(Object.values(this.connections()).flatMap(c=>c.tools.map(t=>t.name)));
    const allowed=new Set(this.list(principal,String(session.metadata?.botId??'')).flatMap(c=>c.tools.map(t=>t.name)));
    // Drop only the foreign software executor. A builtin that shares the name stays.
    return tools.filter(t=>!all.has(t.name)||allowed.has(t.name)||!isSoftwareConnectionTool(t));
  }
  tools():ToolContract[] {
    const names=new Map<string,SoftwareTool>();const writes=new Set<string>();
    for(const c of Object.values(this.connections())) for(const t of c.tools) {if(!names.has(t.name))names.set(t.name,t);if(writeTool(t))writes.add(t.name);}
    return [...names.values()].map(t=>markSoftwareConnectionTool({name:t.name,description:t.description,inputSchema:t.inputSchema,approvalMode:'auto',sideEffectLevel:writes.has(t.name)?'system':'none',needsApproval:()=>writes.has(t.name),execute:(ctx,args)=>this.execute(ctx,t.name,args as Record<string,unknown>)}));
  }
  private secret(c:SoftwareConnection):string|undefined {const name=c.secretEnv??c.credRef?.replace(/^vault:/,'');if(!name)return undefined;assertSoftwareCredentialName(name);return this.env[name]??new SecretVault(this.store).resolveNamed([name])[name];}
  async probe(principal:string,botId:string,id:string):Promise<SoftwareConnection> {
    const c=this.list(principal,botId).find(c=>c.connectorId===id);if(!c)throw new ValidationError('Connection not found');
    try {
      if((c.secretEnv||c.credRef)&&!this.secret(c))throw new Error('Credential unavailable');
      for(const t of c.tools) if(t.executor.kind==='http') {
        const url=new URL(t.executor.url.replace(/\{[^}]+\}/g,'probe'));const address=await this.validateUrl(url);
        const secret=this.secret(c);const headers:Record<string,string>={};
        if(secret&&t.executor.auth){const auth=t.executor.auth;if(auth.kind==='bearer')headers.authorization='Bearer '+secret;else if(auth.kind==='header')headers[auth.name??'X-API-Key']=secret;else url.searchParams.set(auth.name??'api_key',secret);}
        const response=await requestApprovedAddress(url,address,{method:'HEAD',headers,signal:AbortSignal.timeout(5000)});await response.body?.cancel();if(!response.ok)throw new Error('Probe failed');
      } else throw new Error('MCP readiness requires a successful tool invocation');
      c.health='ready';
    } catch {c.health='unavailable';}
    const rows=this.connections(),key=connectionKey(principal,botId,id);
    if(!rows[key]||rows[key]!.revision!==c.revision)throw new ValidationError('Connection changed or revoked during probe');
    c.lastProbeAt=new Date().toISOString();rows[key]=c;this.store.setDaemonControl(CONNECTIONS,rows);return c;
  }
  private async validateUrl(url:URL):Promise<string> {
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Address policy denied');
    const allowPrivate=['1','true','yes'].includes(String(this.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE).toLowerCase());
    const host=url.hostname.replace(/^\[|\]$/g,'');
    const addresses=isIP(host)?[{address:host}]:await lookup(host,{all:true});
    if(!addresses.length||!allowPrivate&&addresses.some(a=>privateAddress(a.address)))throw new Error('Private address denied by network policy');
    return addresses[0]!.address;
  }
  private executionBinding(ctx: RunContext, name: string): ExecutionBinding | undefined {
    const principal = this.principal({userId: ctx.session.metadata?.userId as string | undefined, tenantId: ctx.session.metadata?.tenantId as string | undefined});
    const botId = String(ctx.session.metadata?.botId ?? '');
    const connection = this.list(principal, botId).find(item => item.tools.some(tool => tool.name === name));
    const tool = connection?.tools.find(item => item.name === name);
    if (!connection || !tool) return undefined;
    return {principal, botId, connection, tool, secret: this.secret(connection)};
  }
  private existingInvocation(requestHash: string, fingerprint: string): ToolExecutionResult | undefined {
    const uncertain = this.ledger.uncertain(requestHash);
    if (uncertain) return {ok: false, content: `Invocation ${uncertain.id} is ${uncertain.state}; verify before retrying`};
    const prior = this.ledger.fingerprint(fingerprint);
    if (!prior) return undefined;
    if (prior.requestHash !== requestHash) return {ok: false, content: 'Idempotency key was already used with different arguments'};
    return prior.result ?? {ok: false, content: `Invocation ${prior.id} is ${prior.state}; verify before retrying`};
  }
  private newInvocation(ctx: RunContext, binding: ExecutionBinding, requestHash: string, fingerprint: string): Invocation {
    const taskId = ctx.task?.id ?? ctx.session.metadata?.botWorkTaskId ?? ctx.session.metadata?.routineRunId;
    const row: Invocation = {id: randomUUID(), sessionId: ctx.session.id, principal: binding.principal, botId: binding.botId,
      connectorId: binding.connection.connectorId, toolName: binding.tool.name, fingerprint, requestHash,
      state: 'running', write: writeTool(binding.tool), startedAt: new Date().toISOString()};
    const trackedTask = ctx.task?.id || ctx.session.metadata?.botWorkTaskId || ctx.session.metadata?.routineRunId;
    if (trackedTask) row.taskId = String(taskId);
    this.ledger.put(row);
    return row;
  }
  private assertCurrentConnection(binding: ExecutionBinding): void {
    const current = this.connections()[connectionKey(binding.principal, binding.botId, binding.connection.connectorId)];
    if (!current || current.revision !== binding.connection.revision) throw new Error('Connection revoked');
  }
  private updateHealth(binding: ExecutionBinding, health: SoftwareConnection['health']): void {
    const rows = this.connections();
    const key = connectionKey(binding.principal, binding.botId, binding.connection.connectorId);
    const current = rows[key];
    if (!current || current.revision !== binding.connection.revision) return;
    current.health = health;
    this.store.setDaemonControl(CONNECTIONS, rows);
  }
  private completeInvocation(row: Invocation, binding: ExecutionBinding, result: ToolExecutionResult): ToolExecutionResult {
    const safe = JSON.parse(redact(JSON.stringify(result), binding.secret)) as ToolExecutionResult;
    this.updateHealth(binding, safe.ok ? 'ready' : 'degraded');
    row.state = safe.ok ? 'completed' : row.write ? 'unknown' : 'failed';
    row.result = safe;
    row.finishedAt = new Date().toISOString();
    this.ledger.put(row);
    return safe;
  }
  private failInvocation(row: Invocation, binding: ExecutionBinding, dispatched: boolean, error: unknown): ToolExecutionResult {
    this.updateHealth(binding, 'degraded');
    row.state = row.write && dispatched ? 'unknown' : 'failed';
    row.error = redact(error instanceof Error ? error.message : String(error), binding.secret);
    row.finishedAt = new Date().toISOString();
    row.result = {ok: false, content: `Invocation ${row.id}: ${row.state}: ${row.error}`};
    this.ledger.put(row);
    return row.result;
  }
  private async invokeMcpTool(ctx: RunContext, executor: McpExecutor, args: Record<string, unknown>, dispatch: () => void): Promise<ToolExecutionResult> {
    if (!this.invokeMcp) throw new Error('MCP executor unavailable');
    const callArgs = {...args};
    delete callArgs.idempotency_key;
    const signal = executionSignal(ctx, 30000);
    dispatch();
    return new Promise<ToolExecutionResult>((resolve, reject) => {
      const abort = () => reject(new Error('MCP wait cancelled; external effects may be unconfirmed'));
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) {abort(); return;}
      void this.invokeMcp!(executor.toolName, callArgs, {...ctx, abortSignal: signal}).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private async fetchHttpResponse(binding: ExecutionBinding, executor: HttpExecutor, request: PreparedHttpRequest, dispatch: () => void): Promise<Response> {
    let url = request.url;
    for (let hop = 0; hop < 6; hop++) {
      const address=await this.validateUrl(url);
      this.assertCurrentConnection(binding);
      dispatch();
      const response = await requestApprovedAddress(url, address, {method: executor.method ?? 'GET', headers: request.headers, body: request.body, signal: request.signal});
      const location = response.headers.get('location');
      const redirect = response.status >= 300 && response.status < 400;
      if (!redirect) return response;
      if (!location) throw new Error('Redirect limit exceeded');
      await response.body?.cancel();
      const next = new URL(location, url);
      if (writeTool(binding.tool) || next.origin !== url.origin) throw new Error('Cross-origin or write redirect refused');
      url = next;
    }
    throw new Error('Redirect limit exceeded');
  }
  private async invokeHttpTool(ctx: RunContext, binding: ExecutionBinding, executor: HttpExecutor, args: Record<string, unknown>, row: Invocation, key: string | undefined, dispatch: () => void): Promise<ToolExecutionResult> {
    const request = prepareHttpRequest(ctx, executor, args, row.write, binding.secret, key);
    const response = await this.fetchHttpResponse(binding, executor, request, dispatch);
    const body = await readHttpResponse(response, executor.maxBytes ?? 2000000);
    return {ok: response.ok, content: fenceExternalContent({source: 'mcp', label: binding.tool.name, body}), metadata: {status: response.status, invocationId: row.id}};
  }
  async execute(ctx: RunContext, name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    let binding: ExecutionBinding | undefined;
    try { binding = this.executionBinding(ctx, name); }
    catch (error) { return {ok: false, content: error instanceof Error ? error.message : String(error)}; }
    if (!binding) return {ok: false, content: 'Connection not granted for this Bot'};
    if ((binding.connection.secretEnv || binding.connection.credRef) && !binding.secret) return {ok: false, content: 'Credential unavailable'};
    const inputError = validateSoftwareArguments(binding.tool.inputSchema, args);
    if (inputError) return {ok: false, content: inputError};
    const key = typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined;
    const {requestHash, fingerprint} = invocationIdentity(binding, args, key);
    const prior = this.existingInvocation(requestHash, fingerprint);
    if (prior) return prior;
    const row = this.newInvocation(ctx, binding, requestHash, fingerprint);
    let dispatched = false;
    const dispatch = () => {dispatched = true;};
    try {
      if (ctx.abortSignal?.aborted) throw new Error('Operation cancelled before dispatch');
      this.assertCurrentConnection(binding);
      const executor = binding.tool.executor;
      const result = executor.kind === 'mcp'
        ? await this.invokeMcpTool(ctx, executor, args, dispatch)
        : await this.invokeHttpTool(ctx, binding, executor, args, row, key, dispatch);
      return this.completeInvocation(row, binding, result);
    } catch (error) {
      return this.failInvocation(row, binding, dispatched, error);
    }
  }
}
