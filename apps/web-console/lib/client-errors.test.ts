import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClientError, createErrorReporter, installErrorListeners } from './client-errors.ts';
import { singleFlight } from './single-flight.ts';
test('runtime, rejection and React errors keep stack/context without page secrets [AC:lab-poll-crash-diagnostics#AC-3]',()=>{
 const context={page:'/app?token=secret#/chat?password=secret',sessionId:'s',buildId:'build',userAgent:'browser'};
 const row=makeClientError('react',new Error('boom'),context,'Component stack');
 assert.match(row.stack,/boom/);assert.equal(row.componentStack,'Component stack');assert.equal(row.sessionId,'s');assert.equal(row.page,'/app#/chat');
 const target=new EventTarget();const captured:any[]=[];const remove=installErrorListeners(target,(...args)=>captured.push(args));
 const error=new Event('error');Object.assign(error,{error:new Error('runtime')});target.dispatchEvent(error);
 const rejection=new Event('unhandledrejection');Object.assign(rejection,{reason:new Error('async')});target.dispatchEvent(rejection);
 assert.deepEqual(captured.map(x=>x[0]),['error','unhandledrejection']);remove();target.dispatchEvent(error);assert.equal(captured.length,2);
});
test('reporter deduplicates, caps and swallows delivery failure [AC:lab-poll-crash-diagnostics#AC-4]',async()=>{
 let calls=0;const report=createErrorReporter(async()=>{calls++;throw new Error('offline');});
 const ctx={page:'/',sessionId:'s',buildId:'b',userAgent:'test'};
 for(let i=0;i<100;i++)await report(makeClientError('error',new Error('same'),ctx));
 assert.equal(calls,1);
 for(let i=0;i<100;i++)await report(makeClientError('error',new Error('different'+i),ctx));
 assert.equal(calls,10);
});
test('overlapping overview refreshes join the same pending request and release on failure [AC:lab-poll-crash-diagnostics#AC-2]',async()=>{
 let calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const run=singleFlight(async()=>{calls++;await gate;throw new Error('offline');});
 const a=run(),b=run();assert.equal(a,b);release();await assert.rejects(a);assert.equal(calls,1);await assert.rejects(run());assert.equal(calls,2);
});
