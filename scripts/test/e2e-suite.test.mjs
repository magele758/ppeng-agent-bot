import test from 'node:test';
import assert from 'node:assert/strict';
import { runIsolatedFiles } from '../e2e-suite.mjs';
test('every browser file gets a separate invocation and evidence path; failures are retained without retries',async()=>{
 const calls=[];
 const result=await runIsolatedFiles(['e2e/a.spec.ts','e2e/b.spec.ts','e2e/c.spec.ts'],{args:['--retries=0'],env:{PLAYWRIGHT_JUNIT_OUTPUT_FILE:'/tmp/results/e2e.xml'},run:async(args,env)=>{calls.push({args,env});return calls.length===2?1:0;}});
 assert.equal(result.passed,false);assert.deepEqual(result.results.map(r=>r.code),[0,1,0]);assert.equal(calls.length,3);
 for(let i=0;i<3;i++){assert.equal(calls[i].args[0],['e2e/a.spec.ts','e2e/b.spec.ts','e2e/c.spec.ts'][i]);assert.ok(calls[i].args.includes('--retries=0'));}
 assert.equal(new Set(calls.map(c=>c.args.at(-1))).size,3);
 assert.equal(new Set(calls.map(c=>c.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE)).size,3);
});
test('an empty browser suite cannot pass',async()=>{
 await assert.rejects(()=>runIsolatedFiles([],{run:async()=>0}),/empty/);
});
