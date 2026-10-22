/** Run the full browser inventory with a fresh daemon/database for each spec file. */
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runWithCleanup } from './e2e-lifecycle.mjs';
import { sanitizeScriptEnv } from './spawn-utils.mjs';

export async function runIsolatedFiles(files,{args=[],env={},run}) {
 if(!files.length)throw new Error('Cannot validate an empty browser suite');
 if(env.PLAYWRIGHT_BASE_URL)throw new Error('File isolation requires runner-owned temporary services');
 const results=[];
 for(const [index,file] of files.entries()) {
  const id=String(index+1).padStart(3,'0')+'-'+basename(file,'.spec.ts');
  const childEnv={...env};
  if(env.PLAYWRIGHT_JUNIT_OUTPUT_FILE)childEnv.PLAYWRIGHT_JUNIT_OUTPUT_FILE=join(dirname(env.PLAYWRIGHT_JUNIT_OUTPUT_FILE),id+'.xml');
  const code=await run([file,...args,'--output',join('test-results','playwright',id)],childEnv);
  results.push({file,code});
 }
 return {passed:results.every(result=>result.code===0),results};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const files=readdirSync(join(root,'e2e'),{recursive:true}).filter(file=>file.endsWith('.spec.ts')).sort().map(file=>join('e2e',file));
 process.exitCode=await runWithCleanup(async registry=>{
  const result=await runIsolatedFiles(files,{args:process.argv.slice(2),env:sanitizeScriptEnv(),run:async(args,env)=>{
   console.log('[e2e isolated file] '+args[0]);
   return registry.spawnTask(process.execPath,['scripts/e2e-run.mjs',...args],{cwd:root,env});
  }});
  mkdirSync(join(root,'test-results'),{recursive:true});
  writeFileSync(join(root,'test-results','e2e-suite.json'),JSON.stringify(result,null,2)+'\n');
  return result.passed?0:1;
 });
}
