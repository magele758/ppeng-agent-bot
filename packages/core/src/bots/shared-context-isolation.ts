/** Derived context from a departed sharing domain stays in the UI, not in model recall. */
export interface SharedExposureWindow {
  fromSeq: number;
  toSeq: number;
  startedAt: string;
  endedAt: string;
  /** Include late results from the old run until the next user turn starts. */
  pending?: boolean;
}
export interface SharedExposureState {
  active?: { groupId: string; fromSeq: number; startedAt: string };
  revoked: SharedExposureWindow[];
}
export interface SharedExposureLookup { getDaemonControl?(key: string): unknown; setDaemonControl?(key:string,value:unknown):void }
export const sharedExposureKey = (sessionId: string) => `bot.sharedExposure:${sessionId}`;
export function sharedExposureState(store: SharedExposureLookup | undefined, sessionId: string): SharedExposureState {
  const value=store?.getDaemonControl?.(sharedExposureKey(sessionId)) as SharedExposureState | undefined;
  return value && Array.isArray(value.revoked) ? value : {revoked:[]};
}
export function hasRevokedSharedContext(store: SharedExposureLookup | undefined,sessionId: string): boolean {
  return sharedExposureState(store,sessionId).revoked.length>0;
}
export function sharedMessageVisible(store: SharedExposureLookup | undefined,sessionId: string,message: {seq?:number;key?:string;surfaceOp?:string;replacesStart?:number;replacesEnd?:number}): boolean {
  const {revoked}=sharedExposureState(store,sessionId);
  if(!revoked.length)return true;
  // Compaction may contain arbitrary paraphrases of removed source ranges.
  if(message.key==='compact-summary'||!Number.isSafeInteger(message.seq))return false;
  const from=message.replacesStart??message.seq!,to=message.replacesEnd??message.seq!;
  return !revoked.some(range=>from<=(range.pending?Number.MAX_SAFE_INTEGER:range.toSeq)&&to>=range.fromSeq);
}
export function sealSharedExposure(store: SharedExposureLookup,sessionId:string,messages: Array<{role:string;seq?:number}>):void {
  const state=sharedExposureState(store,sessionId);
  if(!state.revoked.some(range=>range.pending))return;
  const lastUser=messages.findLast(message=>message.role==='user'&&Number.isSafeInteger(message.seq));
  if(!lastUser?.seq)return;
  let changed=false;
  const revoked=state.revoked.map(range=>{
    if(!range.pending||lastUser.seq!<=range.toSeq)return range;
    changed=true;
    return {...range,toSeq:lastUser.seq!-1,endedAt:new Date().toISOString(),pending:false};
  });
  if(changed)store.setDaemonControl?.(sharedExposureKey(sessionId),{...state,revoked});
}
export function sharedMemoryVisible(store: SharedExposureLookup | undefined,row: unknown,fallbackSessionId?:string): boolean {
  if(!row||typeof row!=='object')return true;
  const entry=row as {sessionId?:string;updatedAt?:string;createdAt?:string;sourceRefs?:Array<{sessionId:string;seq?:number}>};
  for(const ref of entry.sourceRefs??[]) {
    if(!sharedMessageVisible(store,ref.sessionId,{seq:ref.seq}))return false;
  }
  const sessionId=entry.sessionId??fallbackSessionId;
  if(!sessionId)return true; // Independent, manually entered personal memory has no revoked source.
  const {revoked}=sharedExposureState(store,sessionId);
  if(!revoked.length)return true;
  const stamps=[entry.createdAt,entry.updatedAt].filter((stamp):stamp is string=>typeof stamp==='string'&&Number.isFinite(Date.parse(stamp)));
  if(!stamps.length)return false;
  return !revoked.some(range=>stamps.some(stamp=>stamp>=range.startedAt&&(range.pending||stamp<=range.endedAt)));
}
