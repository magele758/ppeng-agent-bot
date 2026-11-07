import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ValidationError } from '@ppeng/agent-core';
import { redactEnvValues } from '../../../packages/core/dist/sandbox/result-redaction.js';

function clean(value: unknown, limit: number): string {
 if (typeof value !== 'string') return '';
 return value.slice(0, limit).replace(/(https?:\/\/[^\s?#)]+)[?#][^\s)]*/g, '$1')
  .replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED]');
}
function cleanPage(value: unknown): string {
 return clean(value, 1000).split('#').map(part => part.split('?')[0]).join('#');
}
export function clientErrorRecord(input: unknown) {
 if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Invalid client error');
 const row = input as Record<string, unknown>;
 return redactEnvValues({receivedAt:new Date().toISOString(), at:clean(row.at,64),kind:clean(row.kind,40),
  message:clean(row.message,2000),stack:clean(row.stack,8000),componentStack:clean(row.componentStack,4000),
  page:cleanPage(row.page),sessionId:clean(row.sessionId,160),buildId:clean(row.buildId,160),userAgent:clean(row.userAgent,512)},process.env);
}
async function rotate(file: string, limit: number) {
 const size = await stat(file).then(info => info.size, () => 0);
 if (size >= limit) await rename(file, file + '.1');
}
export function createClientErrorWriter(stateDir: string, limit = 2_000_000) {
 const directory = join(stateDir,'logs');
 const file = join(directory,'client-errors.jsonl');
 let pending = Promise.resolve();
 let queued = 0;
 return async (input: unknown) => {
  const record = clientErrorRecord(input);
  if (queued >= 20) return;
  queued++;
  const next = pending.then(async () => {
   await mkdir(directory,{recursive:true,mode:0o700});
   await rotate(file,limit);
   await appendFile(file,JSON.stringify(record)+'\n',{mode:0o600});
  }).finally(()=>{queued--;});
  pending = next.catch(()=>{});
  await next;
 };
}
