import { classifyModelError } from '../model/error-class.js';
import type { SqliteStateStore } from '../storage.js';
import type { RoutineRun } from './routine-runtime.js';
import type { CronJobRecord } from './cron-store.js';
import { ValidationError } from '../errors.js';

export type RoutineFailureClass = 'transient' | 'hard';
export interface RoutineFailurePolicy {
  hardFailureThreshold: number;
  maxBackoffMs: number;
  notificationCooldownMs: number;
}
export interface RoutineHealthNotice { kind: 'failure' | 'recovery'; at: number; runId: string }
export interface RoutineHealth {
  policy: RoutineFailurePolicy;
  failures: number;
  hardFailures: number;
  paused: boolean;
  pauseReason?: string;
  nextEligibleAt?: number;
  lastFailureAt?: number;
  lastFailureClass?: RoutineFailureClass;
  lastAlertAt?: number;
  incidentNotified?: boolean;
  resumeAfter?: number;
  notices: RoutineHealthNotice[];
}
const defaults: RoutineFailurePolicy = { hardFailureThreshold: 7, maxBackoffMs: 3600000, notificationCooldownMs: 1800000 };
export function isGovernedRoutine(job: CronJobRecord): boolean { return job.scheduleKind === 'every_ms' || job.scheduleKind === 'cron5'; }
export function classifyRoutineFailure(error: unknown): RoutineFailureClass {
  // Billing exhaustion is a hard fault even when an upstream reports HTTP 429.
  // Reuse adapter classification for status-in-message and bounded cause chains.
  let value:unknown=error;
  for(let depth=0;depth<5;depth++){
    const entry=value && typeof value==='object'?value as Record<string,unknown>:undefined;
    const text=entry?[entry.message,entry.code,entry.type].filter(x=>typeof x==='string').join(' '):typeof value==='string'?value:'';
    if(/precheck|credential|billing|insufficient[_ ]quota|payment required|credit balance/i.test(text))return 'hard';
    value=entry?.cause;if(!value)break;
  }
  return classifyModelError(error).upstreamRetryable?'transient':'hard';
}
function delay(state: RoutineHealth): number {
  return state.failures < 2 ? 0 : Math.min(state.policy.maxBackoffMs, 120000 * 2 ** Math.min(30, state.failures - 2));
}
/** State and outcome receipts share a transaction, including across daemon instances. */
export class RoutineHealthStore {
  constructor(private store: Pick<SqliteStateStore,'db'>) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS routine_health (routine_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routine_health_receipts (run_id TEXT NOT NULL,attempt INTEGER NOT NULL,PRIMARY KEY(run_id,attempt));`);
  }
  get(id: string): RoutineHealth {
    const row = this.store.db.prepare('SELECT payload FROM routine_health WHERE routine_id=?').get(id);
    return row ? JSON.parse(String(row.payload)) : {policy:{...defaults},failures:0,hardFailures:0,paused:false,notices:[]};
  }
  private save(id: string,state: RoutineHealth): void {
    this.store.db.prepare('INSERT INTO routine_health(routine_id,payload) VALUES(?,?) ON CONFLICT(routine_id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(state));
  }
  private transaction<T>(action:()=>T):T {
    const own=!this.store.db.isTransaction;
    if(own)this.store.db.exec('BEGIN IMMEDIATE');
    try {const result=action();if(own)this.store.db.exec('COMMIT');return result;}
    catch(error){if(own)this.store.db.exec('ROLLBACK');throw error;}
  }
  configure(id: string,patch: unknown): RoutineHealth {
    if(!patch || typeof patch!=='object' || Array.isArray(patch))throw new ValidationError('Invalid failure policy');
    const limits: Record<string,[number,number]>={hardFailureThreshold:[1,100],maxBackoffMs:[120000,86400000],notificationCooldownMs:[0,604800000]};
    for(const [key,value] of Object.entries(patch)) {
      const range=limits[key];
      if(!range || typeof value!=='number' || !Number.isSafeInteger(value) || value<range[0] || value>range[1])throw new ValidationError(`Invalid failure policy: ${key}`);
    }
    return this.transaction(()=>{
      const state=this.get(id);Object.assign(state.policy,patch);
      if(state.lastFailureAt!==undefined && state.failures>=2)state.nextEligibleAt=state.lastFailureAt+delay(state);
      if(state.hardFailures>=state.policy.hardFailureThreshold){state.paused=true;state.pauseReason='hard_failure_threshold';}
      this.save(id,state);return state;
    });
  }
  observe(run: Pick<RoutineRun,'id'|'attempt'|'routineId'|'job'|'status'|'error'|'failureClass'>,now=Date.now()): void {
    if(!isGovernedRoutine(run.job) || !['failed','completed'].includes(run.status))return;
    this.transaction(()=>{
      const inserted=this.store.db.prepare('INSERT OR IGNORE INTO routine_health_receipts(run_id,attempt) VALUES(?,?)').run(run.id,run.attempt);
      if(!inserted.changes)return;
      const state=this.get(run.routineId);
      if(run.status==='completed') {
        if(state.incidentNotified)state.notices.push({kind:'recovery',at:now,runId:run.id});
        state.failures=0;state.hardFailures=0;delete state.nextEligibleAt;delete state.lastFailureAt;state.incidentNotified=false;
        // An automatic pause requires an explicit owner resume even if a manual retry succeeds.
      } else {
        const kind=run.failureClass??classifyRoutineFailure(run.error);
        state.failures++;if(kind==='hard')state.hardFailures++;
        state.lastFailureClass=kind;state.lastFailureAt=now;
        const wait=delay(state);if(wait)state.nextEligibleAt=now+wait;
        if(state.hardFailures>=state.policy.hardFailureThreshold){state.paused=true;state.pauseReason='hard_failure_threshold';}
        if(state.failures===1 && (state.lastAlertAt===undefined || now-state.lastAlertAt>=state.policy.notificationCooldownMs)) {
          state.notices.push({kind:'failure',at:now,runId:run.id});state.lastAlertAt=now;state.incidentNotified=true;
        }
      }
      state.notices=state.notices.slice(-100);this.save(run.routineId,state);
    });
  }
  allows(job: CronJobRecord,now=Date.now()): boolean {
    if(!isGovernedRoutine(job))return true;
    const state=this.get(job.id);return !state.paused && (state.nextEligibleAt??0)<=now;
  }
  resume(id: string,now=Date.now()): RoutineHealth {
    return this.transaction(()=>{
      const state=this.get(id);state.paused=false;delete state.pauseReason;
      state.failures=0;state.hardFailures=0;delete state.nextEligibleAt;delete state.lastFailureAt;
      state.resumeAfter=now;this.save(id,state);return state;
    });
  }
}
