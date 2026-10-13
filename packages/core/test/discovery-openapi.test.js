import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOpenApiSpec } from '../dist/discovery/adapters/openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures/openapi/petstore-mini.json');

test('openapi adapter: petstore mini → draft tools', () => {
  const spec = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const { capability, tools } = parseOpenApiSpec(spec);
  assert.equal(capability.kind, 'openapi');
  assert.equal(capability.trust, 'untrusted');
  assert.equal(capability.name, 'Petstore Mini');
  assert.ok(tools.length >= 3);
  assert.ok(tools.some((t) => t.toolName === 'listPets'));
  assert.ok(tools.every((t) => t.schemaHash && t.schemaHash.length === 64));
});
test('OpenAPI authenticates supported schemes and rejects unsupported operations [AC:bot-software-execution#AC-2]',()=>{
 const base={openapi:'3.0.3',info:{title:'authentication'},servers:[{url:'https://api.example'}],components:{securitySchemes:{bearer:{type:'http',scheme:'bearer'},header:{type:'apiKey',in:'header',name:'X-Token'},query:{type:'apiKey',in:'query',name:'token'},oauth:{type:'oauth2'}}}};
 for(const [name,auth] of [['bearer',{kind:'bearer'}],['header',{kind:'header',name:'X-Token'}],['query',{kind:'query',name:'token'}]]) {
  const parsed=parseOpenApiSpec({...base,security:[{[name]:[]}],paths:{'/read':{get:{operationId:'read'}}}});assert.deepEqual(parsed.tools[0].executor.auth,auth);
 }
 const badOperations=[
  {security:[{oauth:[]}]}, {security:[{bearer:[],header:[]}]}, {security:[{bearer:[]},{header:[]}]},
  {callbacks:{}}, {parameters:[{name:'items',in:'query',schema:{type:'array'}}]},
  {parameters:[{name:'id',in:'query',schema:{type:'string'},style:'deepObject'}]},
  {parameters:[{name:'id',in:'query',schema:{type:'string'},allowReserved:true}]},
  {parameters:[{name:'id',in:'query',schema:{type:'string'}},{name:'id',in:'path',schema:{type:'string'}}]},
  {requestBody:{content:{'multipart/form-data':{}}}}, {responses:{200:{content:{'text/xml':{}}}}},
  {requestBody:{content:{'application/json':{schema:{$ref:'https://external.example/schema'}}}}},
  {requestBody:{content:{'application/json':{schema:{$ref:'#/components/schemas/Missing'}}}}},
  {operationId:'invalid name'}
 ];
 for(const operation of badOperations){const parsed=parseOpenApiSpec({...base,paths:{'/read':{get:operation}}});assert.equal(parsed.tools.length,0);assert.equal(parsed.unsupported.length,1);assert.match(parsed.unsupported[0].reason,/unsupported|unresolved/);}
 const recursive=parseOpenApiSpec({...base,components:{schemas:{Self:{$ref:'#/components/schemas/Self'}}},paths:{'/read':{get:{requestBody:{content:{'application/json':{schema:{$ref:'#/components/schemas/Self'}}}}}}}});assert.match(recursive.unsupported[0].reason,/recursive/);
 const duplicates=parseOpenApiSpec({...base,paths:{'/one':{get:{operationId:'same'}},'/two':{get:{operationId:'same'}}}});assert.equal(duplicates.tools.length,1);assert.match(duplicates.unsupported[0].reason,/duplicate/);
 const fallback=parseOpenApiSpec({openapi:'3.1.0',paths:{'/write':{post:{description:'write body',requestBody:{content:{'application/json':{}}}}}}},{name:'fallback',endpoint:'https://example.com'});assert.equal(fallback.capability.name,'fallback');assert.deepEqual(fallback.capability.scope,['read','write']);assert.equal(fallback.tools[0].description,'write body');
 assert.throws(()=>parseOpenApiSpec(null),/must be an object/);
});
test('OpenAPI never silently executes server overrides against the root server [AC:bot-software-execution#AC-2]',()=>{for(const position of ['path','operation']){const operation={operationId:'write_override',responses:{200:{}}},path={post:operation};(position==='path'?path:operation).servers=[{url:'https://staging.example'}];const parsed=parseOpenApiSpec({openapi:'3.1.0',servers:[{url:'https://production.example'}],paths:{'/write':path}});assert.equal(parsed.tools.length,0);assert.match(parsed.unsupported[0].reason,/server override/);}});
