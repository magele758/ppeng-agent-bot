import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {sanitizeScriptEnv} from '../spawn-utils.mjs';
const root=resolve(import.meta.dirname,'../..');
const read=p=>readFileSync(join(root,p),'utf8');
const pkg=()=>JSON.parse(read('package.json'));
const config=()=>createRequire(import.meta.url)('yaml').parse(read('pnpm-workspace.yaml'));

test('clean workspace policy links only local internal packages [AC:pnpm-migration#AC-1]',()=>{
 assert.equal(pkg().packageManager,'pnpm@10.29.2');assert.deepEqual(config().packages,['apps/*','packages/*']);
 for(const dir of ['apps','packages'])for(const name of readdirSync(join(root,dir))){const p=join(root,dir,name,'package.json');if(!existsSync(p))continue;const json=JSON.parse(readFileSync(p,'utf8'));for(const group of ['dependencies','devDependencies','optionalDependencies'])for(const [name,spec] of Object.entries(json[group]??{}))if(name.startsWith('@ppeng/'))assert.match(spec,/^workspace:/,`${p}: ${name}`);}
});
test('single immutable installation lock [AC:pnpm-migration#AC-2]',()=>{
 assert.ok(existsSync(join(root,'pnpm-lock.yaml')));assert.equal(existsSync(join(root,'package-lock.json')),false);assert.equal(existsSync(join(root,'yarn.lock')),false);
});
test('dev launcher selects pnpm workspace and preserves port selection [AC:pnpm-migration#AC-3]',()=>{
 const source=read('scripts/dev-lab.mjs');assert.match(source,/resolveBin\('pnpm'\)/);assert.match(source,/--filter/);assert.match(source,/pickPort/);assert.doesNotMatch(source,/resolveBin\('(?:npm|npx)'\)/);
});
test('all package task entrypoints use pnpm or local tools [AC:pnpm-migration#AC-4] [AC:pnpm-migration#AC-5]',()=>{
 for(const path of ['package.json',...['apps','packages'].flatMap(dir=>readdirSync(join(root,dir)).map(name=>`${dir}/${name}/package.json`)).filter(p=>existsSync(join(root,p)))]){
  for(const [name,value] of Object.entries(JSON.parse(read(path)).scripts??{}))assert.doesNotMatch(value,/\b(?:npm\s+(?:run|ci)|npx\b)/,`${path} ${name}`);
 }
});
test('workflow installers pin pnpm before cache setup and retain gates [AC:pnpm-migration#AC-6]',()=>{
 for(const file of readdirSync(join(root,'.github/workflows')).filter(x=>/\.ya?ml$/.test(x))){const source=read(`.github/workflows/${file}`);assert.doesNotMatch(source,/\bnpm ci\b/,file);if(source.includes('pnpm install')){assert.match(source,/pnpm\/action-setup@/);assert.match(source,/--frozen-lockfile/);assert.ok(source.indexOf('pnpm/action-setup@')<source.indexOf('cache: pnpm'),file);}}
 assert.match(read('.github/workflows/ci.yml'),/Quick gate/);
});
test('Docker stages install frozen pnpm dependencies and include runtime links [AC:pnpm-migration#AC-7]',()=>{
 for(const file of ['deploy/docker/Dockerfile.daemon','deploy/docker/Dockerfile.web']){const source=read(file);assert.match(source,/pnpm-lock.yaml/);assert.match(source,/pnpm-workspace.yaml/);assert.match(source,/pnpm install.*--frozen-lockfile/);assert.doesNotMatch(source,/\bnpm ci\b/);}
});
test('self-heal and Evolution retain isolation and use pnpm [AC:pnpm-migration#AC-8]',()=>{
 const heal=read('packages/core/src/self-heal/self-heal-executors.ts');assert.match(heal,/pnpm/);assert.match(heal,/sanitizeSpawnEnv/);assert.match(heal,/killTree/);
 const evolution=read('scripts/evolution-run-day.mjs');assert.match(evolution,/pnpm install --frozen-lockfile/);assert.doesNotMatch(evolution,/sh\('npm ci'/);
});
test('legacy checkout install mode is explicit rather than current-source fallback [AC:pnpm-migration#AC-9]',async()=>{
 const {installationCommand}=await import('../lib/package-manager.mjs');
 const dir=mkdtempSync(join(tmpdir(),'pm-policy-'));try{
 writeFileSync(join(dir,'package-lock.json'),'{}');assert.deepEqual(installationCommand(dir),{command:'npm',args:['ci']});
 writeFileSync(join(dir,'pnpm-lock.yaml'),'lockfileVersion: 9');assert.deepEqual(installationCommand(dir),{command:'pnpm',args:['install','--frozen-lockfile']});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('public artifacts retain npm consumer verification [AC:pnpm-migration#AC-10]',()=>{
 assert.equal(pkg().scripts['test:package'],'node scripts/publish-npm-packages.mjs --check');
 const source=read('scripts/npm-artifacts.mjs');assert.match(source,/runArtifactCommand\('npm', \['install'/);assert.match(source,/assertPortableMini/);assert.match(read('pnpm-workspace.yaml'),/onlyBuiltDependencies/);
});
test('native build scripts require an explicit allowlist [AC:pnpm-migration#AC-11]',()=>{
 const c=config();assert.ok(c.onlyBuiltDependencies.includes('sharp'));assert.ok(c.onlyBuiltDependencies.includes('electron'));assert.equal(c.dangerouslyAllowAllBuilds,undefined);
});
test('migration retains unit, SDK, integration, regression and browser gate entrypoints [AC:pnpm-migration#AC-12]',()=>{
 assert.match(pkg().scripts.ci,/pnpm run test:unit/);for(const name of ['test:acceptance','test:formal','test:package','test:integration','test:regression','test:e2e'])assert.ok(pkg().scripts.ci.includes(name));
 const sdk=JSON.parse(read('packages/agent-loop/package.json'));assert.doesNotMatch(sdk.scripts.test,/npx/);assert.match(sdk.scripts.test,/vitest/);
});
test('current installation guide documents pnpm and npm consumer boundary [AC:pnpm-migration#AC-13]',()=>{
 for(const file of ['README.md','README.zh.md']){const s=read(file);assert.match(s,/pnpm install/);assert.doesNotMatch(s,/^npm install\s*$/m);}
 assert.match(read('doc/PNPM_MIGRATION.md'),/npm/);
});
test('pnpm forwards arguments and exit codes without npm or npx executors [AC:pnpm-migration#AC-14]',()=>{
 assert.equal(pkg().packageManager,'pnpm@10.29.2');
 const dir=mkdtempSync(join(tmpdir(),'pnpm-args-'));try{
 writeFileSync(join(dir,'package.json'),JSON.stringify({private:true,scripts:{probe:'node probe.mjs'},packageManager:pkg().packageManager}));
 writeFileSync(join(dir,'probe.mjs'),`import assert from 'node:assert/strict';assert.deepEqual(process.argv.slice(2),['space value','--flag']);process.exit(17);`);
 const result=spawnSync('pnpm',['run','probe','space value','--flag'],{cwd:dir,env:sanitizeScriptEnv(),encoding:'utf8'});assert.equal(result.status,17,result.stderr+result.stdout);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('performance report declares measured cold/warm samples and limitations [AC:pnpm-migration#AC-15]',()=>{
 const report=JSON.parse(read('doc/pnpm-install-benchmark.json'));assert.ok(report.environment.node);assert.ok(report.limitations.length);
 for(const manager of ['npm','pnpm'])for(const cache of ['cold','warm']){const sample=report.samples.find(s=>s.manager===manager&&s.cache===cache);assert.ok(sample);assert.equal(sample.exitCode,0);assert.ok(sample.elapsedMs>0);assert.ok(sample.nodeModulesBytes>0);}
});

test('fresh local workspace installs offline and frozen mismatch fails before resolution [AC:pnpm-migration#AC-1] [AC:pnpm-migration#AC-2] [AC:pnpm-migration#AC-14]',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pnpm-frozen-'));
 try{
  writeFileSync(join(dir,'package.json'),JSON.stringify({private:true,packageManager:pkg().packageManager}));
  writeFileSync(join(dir,'pnpm-workspace.yaml'),'packages:\n  - packages/*\n');
  for(const name of ['a','b']){const path=join(dir,'packages',name);mkdirSync(path,{recursive:true});writeFileSync(join(path,'package.json'),JSON.stringify({name:`fixture-${name}`,version:'1.0.0',main:'index.cjs',...(name==='a'?{dependencies:{'fixture-b':'workspace:*'}}:{})}));writeFileSync(join(path,'index.cjs'),`module.exports=${JSON.stringify(name)};`);}
  const run=args=>spawnSync('pnpm',args,{cwd:dir,env:sanitizeScriptEnv(),encoding:'utf8',timeout:30000});
  let result=run(['install','--offline','--ignore-scripts']);assert.equal(result.status,0,result.stderr+result.stdout);
  assert.equal(createRequire(join(dir,'packages/a/package.json'))('fixture-b'),'b');
  const frozen=readFileSync(join(dir,'pnpm-lock.yaml'),'utf8');result=run(['install','--offline','--frozen-lockfile']);assert.equal(result.status,0,result.stderr+result.stdout);assert.equal(readFileSync(join(dir,'pnpm-lock.yaml'),'utf8'),frozen);
  const path=join(dir,'packages/a/package.json'),manifest=JSON.parse(readFileSync(path,'utf8'));manifest.dependencies['missing-registry-fixture']='1.0.0';writeFileSync(path,JSON.stringify(manifest));
  result=run(['install','--offline','--frozen-lockfile']);assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/OUTDATED_LOCKFILE/);assert.equal(readFileSync(join(dir,'pnpm-lock.yaml'),'utf8'),frozen);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('allowlisted native dependencies actually load and execute [AC:pnpm-migration#AC-11]',async()=>{
 const coreRequire=createRequire(join(root,'packages/core/package.json'));
 const sharp=coreRequire('sharp');const output=await sharp({create:{width:4,height:4,channels:3,background:'#ff0000'}}).png().toBuffer();assert.equal((await sharp(output).metadata()).width,4);
 const electron=createRequire(join(root,'apps/desktop/package.json'))('electron');assert.ok(existsSync(electron));
 const result=spawnSync(electron,['-e','console.log(process.versions.electron)'],{env:sanitizeScriptEnv({...process.env,ELECTRON_RUN_AS_NODE:'1'}),encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/\d+\.\d+/);
});
