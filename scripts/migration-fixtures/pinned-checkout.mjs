/** Materialize one immutable historical revision without fetching into the candidate repository. */
import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {sanitizeSpawnEnv} from '../../packages/core/dist/sandbox/env-sanitizer.js';

function git(args,cwd){
 const result=spawnSync('git',args,{cwd,encoding:'utf8',env:sanitizeSpawnEnv(),timeout:120000});
 if(result.status!==0)throw new Error(`Pinned fixture Git command failed: ${result.stderr}\n${result.stdout}`);
 return result.stdout.trim();
}

export function preparePinnedCheckout({sourceRoot,checkout,sha}){
 if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('A complete immutable fixture SHA is required');
 const available=spawnSync('git',['cat-file','-e',`${sha}^{commit}`],{cwd:sourceRoot,env:sanitizeSpawnEnv(),stdio:'ignore',timeout:10000}).status===0;
 // A depth-1 Actions checkout lacks old objects. Only this disposable repository
 // fetches the pinned object; candidate refs, shallow boundaries and FETCH_HEAD stay untouched.
 const origin=available?sourceRoot:git(['remote','get-url','origin'],sourceRoot);
 mkdirSync(checkout,{recursive:true});git(['init','--quiet'],checkout);
 git(['fetch','--quiet','--no-tags','--depth=1',origin,sha],checkout);
 git(['checkout','--quiet','--detach',sha],checkout);
 if(git(['rev-parse','HEAD'],checkout)!==sha)throw new Error('Historical fixture revision does not match the pinned SHA');
 return {sha,source:available?'local-object':'origin-pinned-object'};
}
