import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRoutes } from '../dist/routes/compact.js';

test('contract API round trips and rejects stale version and malformed state [AC:always-on-reliability#AC-5]',async()=>{
 const session={id:'s',metadata:{} as Record<string,unknown>};
 const runtime={getSession:(id:string)=>id==='s'?session:undefined,mergeSessionMetadata:(_id:string,patch:Record<string,unknown>)=>Object.assign(session.metadata,patch)};
 const routes=compactRoutes(runtime as never);let result:any;
 const ctx={requireParam:()=> 's',response:{setHeader(){},end(text:string){result=JSON.parse(text);}},readBody:async()=>({version:0,contract:{objective:'draft',constraints:['no sending'],todos:[],evidence:['message:1']}})};
 const patch=routes.find(r=>r.method==='PATCH'&&r.pattern?.endsWith('/reliability'))!;
 await patch.handler(ctx as never);assert.equal(result.contract.version,1);
 await assert.rejects(()=>patch.handler(ctx as never),/changed/);
 await assert.rejects(()=>patch.handler({...ctx,readBody:async()=>({version:1,contract:{objective:123}})} as never),/objective/);
 await routes.find(r=>r.method==='GET'&&r.pattern?.endsWith('/reliability'))!.handler(ctx as never);
 assert.equal(result.contract.constraints[0],'no sending');assert.deepEqual(result.cacheDiagnostics,[]);
});
