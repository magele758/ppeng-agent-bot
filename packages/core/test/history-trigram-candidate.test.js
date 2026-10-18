import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStateStore} from '../dist/storage.js';
import {SessionStore} from '../dist/stores/session-store.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'history-trigram-'));const store=new SqliteStateStore(join(dir,'db'));return {store,history:new SessionStore(store.db),close(){if(store.db.isOpen)store.db.close();rmSync(dir,{recursive:true,force:true});}};}
function expected(db,sessionId,query,opts={}){const clauses=["session_id=?", "(surface_op IS NULL OR surface_op='append')"],args=[sessionId];if(opts.beforeSeq){clauses.push('seq < ?');args.push(opts.beforeSeq);}if(opts.from){clauses.push('created_at >= ?');args.push(opts.from);}if(opts.to){clauses.push('created_at <= ?');args.push(opts.to);}const pattern='%'+query.trim().replace(/[\\%_]/g,'\\$&')+'%';clauses.push("EXISTS(SELECT 1 FROM json_each(parts_json) part WHERE json_extract(part.value,'$.text') LIKE ? ESCAPE '\\' OR json_extract(part.value,'$.content') LIKE ? ESCAPE '\\')");args.push(pattern,pattern);return db.prepare(`SELECT id FROM session_messages WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...args,(opts.limit??50)+1);}
test('literal history search preserves substring Unicode special characters and part boundaries [AC:bot-history-memory#AC-1]',()=>{
 const f=fixture();try{const a=f.store.createSession({title:'a',mode:'chat',agentId:'bot'}),b=f.store.createSession({title:'b',mode:'chat',agentId:'bot'});
 const texts=['http_source_0_17 unique_0_17;', 'httpXsourceX0X17 uniqueX0X17;', '100% literal_under_score', '100X literalXunderXscore', 'say "quoted" and C:\\path\\file', '中文_原始内容', 'École and école and Ångström', 'A OR B NOT C', 'some (parentheses) [brackets]', 'a short a', 'exact_case insensitive', 'line_one\nline_two', 'tab_one\ttab_two', 'a b', 'abc + def'];
 for(const text of texts)f.store.appendMessage(a.id,'user',[{type:'text',text}]);
 f.store.appendMessage(a.id,'user',[{type:'text',text:'split_left'},{type:'text',text:'split_right'}]);
 f.store.appendMessage(a.id,'tool',[{type:'tool_result',toolCallId:'result',content:'tool_result_identifier_7'}]);
 f.store.appendMessage(b.id,'user',[{type:'text',text:'http_source_0_17 unique_0_17; other_bot_only'}]);
 for(const query of [...texts,'HTTP_SOURCE_0_17 UNIQUE_0_17;','100%','_','%','"quoted"','C:\\path','中文','école','split_left split_right','left"},{"type','tool_result_identifier_7','toolCallId','other_bot_only','a']){
  const result=f.history.listHistory(a.id,{query});const wanted=expected(f.store.db,a.id,query).reverse().map(r=>r.id);assert.deepEqual(result.messages.map(m=>m.id),wanted,query);
 }
 }finally{f.close();}
});
test('indexed candidates drive primary-key lookups and preserve unique cursor pages and time filters [AC:bot-history-memory#AC-1] [AC:bot-history-memory#AC-2]',()=>{
 const f=fixture();try{const a=f.store.createSession({title:'a',mode:'chat',agentId:'bot'}),messages=[];for(let i=0;i<15;i++)messages.push(f.store.appendMessage(a.id,'user',[{type:'text',text:'http_source_same_'+i}]));
 for(let i=0;i<messages.length;i++){const stamp=new Date(Date.UTC(2026,9,13,0,0,i)).toISOString();f.store.db.prepare('UPDATE session_messages SET created_at=? WHERE id=?').run(stamp,messages[i].id);messages[i].createdAt=stamp;}
 f.store.db.prepare('INSERT INTO session_history_fts(message_id,session_id,text) SELECT message_id,session_id,text FROM session_history_fts WHERE message_id=?').run(messages[4].id);
 const prepare=f.store.db.prepare.bind(f.store.db);let searchSql;f.store.db.prepare=sql=>{if(sql.startsWith('SELECT')&&sql.includes('ORDER BY')&&sql.includes('LIMIT'))searchSql=sql;return prepare(sql);};
 const first=f.history.listHistory(a.id,{query:'http_source_same_',limit:4});assert.equal(first.hasMore,true);assert.ok(searchSql?.includes('MATCH ?'));assert.ok(searchSql.includes('CROSS JOIN'));
 const pattern='%http\\_source\\_same\\_%';const plan=prepare('EXPLAIN QUERY PLAN '+searchSql).all('"http_source_same_"',a.id,pattern,pattern,5).map(r=>r.detail);assert.ok(plan.some(x=>x.includes('VIRTUAL TABLE INDEX')&&x.includes('M')),JSON.stringify(plan));assert.ok(plan.some(x=>x.includes('(id=?)')),JSON.stringify(plan));console.log(JSON.stringify({candidatePlan:plan}));
 f.store.appendMessage(a.id,'assistant',[{type:'text',text:'http_source_same_new'}]);const ids=first.messages.map(m=>m.id);let cursor=first.nextCursor;while(cursor){const p=f.history.listHistory(a.id,{query:'http_source_same_',limit:4,beforeSeq:cursor});ids.push(...p.messages.map(m=>m.id));cursor=p.nextCursor;}assert.equal(ids.length,15);assert.equal(new Set(ids).size,15);
 const opts={query:'http_source_same_',from:messages[3].createdAt,to:messages[10].createdAt,beforeSeq:messages[8].seq,limit:4};const result=f.history.listHistory(a.id,opts),rows=expected(f.store.db,a.id,opts.query,opts);assert.deepEqual(result.messages.map(m=>m.id),rows.slice(0,4).reverse().map(m=>m.id));assert.equal(result.hasMore,rows.length>4);
 }finally{f.close();}
});
test('history substring search remains available without optional FTS [AC:bot-history-memory#AC-1]',()=>{const f=fixture();try{const a=f.store.createSession({title:'a',mode:'chat',agentId:'bot'}),m=f.store.appendMessage(a.id,'user',[{type:'text',text:'http_source_fallback'}]);f.store.db.exec('DROP TABLE session_history_fts');assert.equal(f.history.listHistory(a.id,{query:'http_source_fallback'}).messages[0].id,m.id);}finally{f.close();}});
