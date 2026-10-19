import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

// Preserve the original stricter no-instrumentation contracts without executing
// the entire functional suite twice. Discover coverage-dependent tests, not a
// hand-maintained allowlist that could omit a newly introduced contract.
const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8', env: sanitizeScriptEnv(), maxBuffer: 16e6
});
if(files.status!==0)throw new Error('Cannot enumerate uninstrumented test contracts');
const tests = [...new Set(files.stdout.split('\0').filter(p=>/\.test\.(?:js|mjs|ts)$/.test(p)))].filter(p=>readFileSync(p,'utf8').includes('process.env.NODE_V8_COVERAGE'));
if(!tests.length)throw new Error('No uninstrumented performance contracts were found');
const env=sanitizeScriptEnv();delete env.NODE_V8_COVERAGE;
const result=spawnSync(process.execPath,['--experimental-strip-types','--test','--test-concurrency=1',...tests],{env,stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
