/** HTTP transport whose socket DNS lookup is bound to the policy-approved address. */
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {isIP, type LookupFunction} from 'node:net';
import {Readable} from 'node:stream';
import {createGunzip, createInflate, createBrotliDecompress} from 'node:zlib';
export interface PinnedRequest {method: string;headers: Record<string,string>;body?: string;signal: AbortSignal}
function pinnedLookup(address: string): LookupFunction {
  return (_host, options, callback) => {
    const family=isIP(address);
    if (!family) {callback(new Error('Invalid approved network address'), '', 0);return;}
    callback(null,options.all?[{address,family}]:address,family);
  };
}
function responseStream(incoming: import('node:http').IncomingMessage, headers: Headers): Readable {
  const encoding=headers.get('content-encoding');
  const decoder=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():undefined;
  if (!decoder) return incoming;
  headers.delete('content-encoding');headers.delete('content-length');
  incoming.on('error',error=>decoder.destroy(error));
  decoder.on('close',()=>incoming.destroy());
  return incoming.pipe(decoder);
}
export function requestApprovedAddress(url: URL, address: string, options: PinnedRequest): Promise<Response> {
  return new Promise((resolve,reject)=>{
    // The original URL preserves Host, TLS SNI and certificate hostname checks.
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:options.method,headers:options.headers,signal:options.signal,lookup:pinnedLookup(address)},incoming=>{
      try {
      const headers=new Headers();
      for (const [name,value] of Object.entries(incoming.headers)) {
        if (value===undefined) continue;
        for (const item of Array.isArray(value)?value:[value]) headers.append(name,item);
      }
      const status=incoming.statusCode??500;
      const noBody=options.method==='HEAD'||[204,205,304].includes(status);
      if (noBody) incoming.resume();
      const body=noBody?null:Readable.toWeb(responseStream(incoming,headers)) as ReadableStream<Uint8Array>;
      resolve(new Response(body,{status,headers}));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.on('error',reject);
    request.end(options.body);
  });
}
