#!/usr/bin/env node
/** Build a relocatable production dependency tree using the workspace lockfile. */
import {spawnSync} from 'node:child_process';
import {cpSync,existsSync,mkdirSync,rmSync,symlinkSync,realpathSync,lstatSync,readdirSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {domainPackagePaths} from './lib/domains-manifest.mjs';
import {resolveBin,sanitizeScriptEnv} from './spawn-utils.mjs';
const repoRoot=join(dirname(fileURLToPath(import.meta.url)),'..');
const bundleDir=join(repoRoot,'apps/desktop/server-bundle');
const packages=['packages/api-types','packages/agent-loop','packages/core','packages/capability-gateway',...domainPackagePaths()];
for(const path of ['apps/daemon',...packages])if(!existsSync(join(repoRoot,path,'dist')))throw new Error(`${path}/dist missing; run pnpm build first`);
rmSync(bundleDir,{recursive:true,force:true});
// Legacy deploy mode supports a symlinked workspace while materializing a standalone tree.
const result=spawnSync(resolveBin('pnpm'),['--filter','@ppeng/agent-daemon','deploy','--legacy','--prod','--prefer-offline',bundleDir],{cwd:repoRoot,env:sanitizeScriptEnv(),stdio:'inherit',shell:false});
if(result.error||result.status!==0)throw result.error??new Error(`pnpm deploy failed (${result.status})`);
// pnpm legacy deploy's hoisted self-reference otherwise points back to the source app.
const self=join(bundleDir,'node_modules/.pnpm/node_modules/@ppeng/agent-daemon');
if(existsSync(self)){rmSync(self);symlinkSync(relative(dirname(self),bundleDir),self,'dir');}
mkdirSync(join(bundleDir,'apps/daemon'),{recursive:true});
cpSync(join(repoRoot,'apps/daemon/dist'),join(bundleDir,'apps/daemon/dist'),{recursive:true});
cpSync(join(repoRoot,'apps/daemon/package.json'),join(bundleDir,'apps/daemon/package.json'));
cpSync(join(repoRoot,'apps/daemon/web-stub'),join(bundleDir,'apps/daemon/web-stub'),{recursive:true});
cpSync(join(repoRoot,'domains.manifest.json'),join(bundleDir,'domains.manifest.json'));
for(const pkg of packages){
 const target=join(bundleDir,pkg);mkdirSync(target,{recursive:true});
 cpSync(join(repoRoot,pkg,'dist'),join(target,'dist'),{recursive:true});
 cpSync(join(repoRoot,pkg,'package.json'),join(target,'package.json'));
}
const realBundle=realpathSync(bundleDir);
function verifyLinks(directory){for(const name of readdirSync(directory)){const path=join(directory,name),stat=lstatSync(path);if(stat.isSymbolicLink()){const target=realpathSync(path);if(target!==realBundle&&!target.startsWith(realBundle+'/'))throw new Error(`Non-relocatable dependency: ${path}`);}else if(stat.isDirectory())verifyLinks(path);}}
verifyLinks(bundleDir);
console.log(`[prepare-server] relocatable pnpm production bundle: ${bundleDir}`);
