import test from 'node:test';
import assert from 'node:assert/strict';
import {botHistoryRoutes} from '../../apps/daemon/dist/routes/bot-history.js';
function response(){return {statusCode:0,headers:{},setHeader(key,value){this.headers[key]=value},end(body){this.body=JSON.parse(body)}};}
test('history API protects foreign sessions before reading original text [AC:bot-history-memory#AC-1]',async()=>{
 let reads=0;const rt={getSession:()=>({id:'secret',metadata:{userId:'owner'}}),store:{listHistory(){reads++;return {messages:[]}}}};
 const route=botHistoryRoutes(rt).find(r=>r.pattern==='/api/sessions/:id/history');
 assert.throws(()=>route.handler({requireParam:()=> 'secret',auth:{isolate:true,user:{id:'stranger'}},response:response(),url:new URL('http://x/api/sessions/secret/history')}));
 assert.equal(reads,0);
});
test('history API pages only bounded raw messages [AC:bot-history-memory#AC-2]',async()=>{
 const rt={getSession:()=>({id:'own',metadata:{userId:'owner'}}),store:{listHistory(id,options){assert.equal(id,'own');assert.equal(options.beforeSeq,10);assert.equal(options.limit,2);return {messages:[{seq:8},{seq:9}],nextCursor:8,hasMore:true}}}};
 const route=botHistoryRoutes(rt).find(r=>r.pattern==='/api/sessions/:id/history');const res=response();
 await route.handler({requireParam:()=> 'own',auth:{isolate:true,user:{id:'owner'}},response:res,url:new URL('http://x/api/sessions/own/history?beforeSeq=10&limit=2')});
 assert.equal(res.statusCode,200);assert.equal(res.body.nextCursor,8);
});
