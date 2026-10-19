import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {redactFactoryOutput} from '../dist/factory/redaction.js';
const moduleUrl=new URL('../dist/factory/redaction.js',import.meta.url).href;
function child(source){return spawnSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {redactFactoryOutput} from ${JSON.stringify(moduleUrl)};${source}`],{encoding:'utf8',timeout:2000,maxBuffer:1024*1024});}
test('factory redaction processes a 1.5MiB credential-free run without blocking the coordinator',()=>{
 const r=child(`const input='x'.repeat(1572864);const actual=redactFactoryOutput(input);assert.equal(actual,input);`);
 assert.equal(r.error?.code,undefined,r.error?.message);assert.equal(r.status,0,r.stderr);
});
test('large repeated protocol and unfinished private-key inputs finish and remain redacted',()=>{
 const r=child(String.raw`const input='x-'.repeat(135000)+' password="many word password" https://private-user:private-password@example.test/ Bearer abc.secret.token\n'+'-----BEGIN PRIVATE KEY-----\n'.repeat(5000)+'private-key-material';const actual=redactFactoryOutput(input);for(const secret of ['many word password','private-password','abc.secret.token','private-key-material'])assert.ok(!actual.includes(secret),secret);`);
 assert.equal(r.error?.code,undefined,r.error?.message);assert.equal(r.status,0,r.stderr);
});
test('redaction keeps all credential classes and environment values protected',()=>{
 process.env.FACTORY_REDACTION_TEST_TOKEN='private-environment-canary';
 try{
 const inputs=[
  'OPENAI_API_KEY=private-api-value','client-secret: private-secret-value','customauthorization: private-header-value','password="private quoted words"',"passwd='private single quoted words'",
  'https://private-user:private-url-password@host.example.test/','123https://private-user:private-digit-url-password@host.example.test/',
  'Authorization: Basic private-auth-header','Proxy-Authorization: Basic private-proxy-header','Cookie: session=private-cookie; more=private-cookie-two','Set-Cookie: session=private-cookie-three; Secure',
  'Bearer private-bearer-token','-----BEGIN RSA PRIVATE KEY-----\nprivate-pem-canary\n-----END RSA PRIVATE KEY-----','private-environment-canary'
 ];
 for(const input of inputs){const clean=redactFactoryOutput(input);assert.ok(!clean.includes('private-'),input);assert.match(clean,/REDACTED/);}
 const nested=redactFactoryOutput({authorization:'private-object-auth',inner:[{client_secret:'private-object-secret'}]});assert.ok(!JSON.stringify(nested).includes('private-'));
 }finally{delete process.env.FACTORY_REDACTION_TEST_TOKEN;}
});
test('adjacent quoted credentials and URLs redact every value without consuming the next boundary',()=>{
 for(const input of ["password='private-adjacent-one'password=\"private-adjacent-two\"",'https://u:private-url-one@https://u:private-url-two@host']){
  const clean=redactFactoryOutput(input);assert.ok(!clean.includes('private-'),clean);
 }
});
