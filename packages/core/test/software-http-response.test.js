import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {requestApprovedAddress} from '../dist/connectors/http-request.js';

test('software transport bounds malformed responses and preserves decompression [AC:bot-software-execution#AC-4]',async()=>{
 const server=createServer((request,response)=>{
  if(request.url==='/invalid'){response.statusCode=600;response.end('invalid');return;}
  response.setHeader('content-encoding','gzip');response.end(gzipSync('verified compressed response'));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const options={method:'GET',headers:{},signal:AbortSignal.timeout(3000)};
 try {
  await assert.rejects(requestApprovedAddress(new URL(base+'/invalid'),'127.0.0.1',options),RangeError);
  const response=await requestApprovedAddress(new URL(base+'/gzip'),'127.0.0.1',options);
  assert.equal(await response.text(),'verified compressed response');
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
