import type { ToolContract, RunContext } from '../types.js';
import type { SqliteStateStore } from '../storage.js';
import type { CronJobRecord, CronJobStore } from './cron-store.js';
import { RoutineRunStore, type RoutineRun, type RoutineRuntimeHost } from './routine-runtime.js';
import { runCronJobNow } from './cron-facade.js';

export interface CronToolOptions {
  store?: SqliteStateStore;
  isEnabled?: () => boolean;
  runtimeHost?: RoutineRuntimeHost;
}
function publicRun(run: RoutineRun): Omit<RoutineRun, 'eventBody'> {
  const { eventBody: _private, ...visible } = run;
  return visible;
}
function owns(opts: CronToolOptions | undefined, context: RunContext, job: CronJobRecord): boolean {
  if (!opts?.store) return false;
  // Live session only — never trust job.metadata.principal after the owning chat is gone
  // (avoids recycled userId/tenantId claiming another tenant's routine).
  const session = opts.store.getSession(job.sessionId);
  if (!session) return false;
  return session.metadata?.userId === context.session.metadata?.userId && session.metadata?.tenantId === context.session.metadata?.tenantId;
}
export function createCronRunTools(getStore: () => CronJobStore, opts?: CronToolOptions): ToolContract<any>[] {
  const unavailable = () => opts?.isEnabled && !opts.isEnabled() ? 'Routine dialog tools are disabled in Lab settings' : !opts?.store ? 'Routine storage unavailable' : undefined;
  const runNow: ToolContract<{id:string}> = {
    name: 'cron_run_now',
    description: 'Run an owned routine now in its serial work queue. Existing approvals and prechecks still apply; future schedule is unchanged.',
    inputSchema: {type:'object',properties:{id:{type:'string'}},required:['id']},
    approvalMode: 'auto', sideEffectLevel: 'workspace', needsApproval: () => true,
    async execute(context, args) {
      const error = unavailable();
      if (error) return {ok:false,content:error};
      const job = getStore().get(args.id);
      if (!job || !owns(opts,context,job)) return {ok:false,content:'Routine not found'};
      if (!opts?.runtimeHost) return {ok:false,content:'Routine executor unavailable'};
      try { return {ok:true,content:JSON.stringify(publicRun(await runCronJobNow(opts.runtimeHost,job)))}; }
      catch (error) { return {ok:false,content:error instanceof Error ? error.message : String(error)}; }
    },
  };
  const runs: ToolContract<{id?:string;run_id?:string;before?:number;limit?:number}> = {
    name: 'cron_runs',
    description: 'Query owned routine runs: id lists a page; run_id gets one run. Use nextCursor as before for older history. Active/unknown runs repeat on each page; merge by id.',
    inputSchema: {type:'object',properties:{id:{type:'string'},run_id:{type:'string'},before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:500}}},
    approvalMode: 'never', sideEffectLevel: 'none',
    async execute(context,args) {
      const error = unavailable();
      if (error) return {ok:false,content:error};
      if (Boolean(args.id) === Boolean(args.run_id)) return {ok:false,content:'Provide exactly one of id or run_id'};
      if ((args.before!==undefined && (!Number.isSafeInteger(args.before)||args.before<1)) || (args.limit!==undefined && (!Number.isInteger(args.limit)||args.limit<1||args.limit>500))) return {ok:false,content:'Invalid pagination'};
      const ledger = new RoutineRunStore(opts!.store!);
      if (args.run_id) {
        const run = ledger.get(args.run_id);
        const live = run ? getStore().get(run.job.id) : undefined;
        if (!run || !live || !owns(opts,context,live)) return {ok:false,content:'Run not found'};
        return {ok:true,content:JSON.stringify(publicRun(run))};
      }
      const job = getStore().get(args.id!);
      if (!job || !owns(opts,context,job)) return {ok:false,content:'Routine not found'};
      const page = ledger.page(args.id!,{before:args.before,limit:args.limit});
      // Ownership already proven via live store job; do not re-check embedded run.job snapshots.
      return {ok:true,content:JSON.stringify({...page,runs:page.runs.map(publicRun)})};
    },
  };
  return [runNow,runs];
}
