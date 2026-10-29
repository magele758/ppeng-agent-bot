// Coverage transfer is a closed bundle: source/toolchain/run identity + complete
// inventory + per-file digests. Consumers must validate before scoring or reuse.
import {createHash} from 'node:crypto';
import {readdirSync,readFileSync,writeFileSync,mkdirSync,lstatSync,copyFileSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {sanitizeScriptEnv} from '../spawn-utils.mjs';
import {parseJUnit} from '../acceptance/acceptance-lib.mjs';
import {ROOT,discoverTests} from './test-partition.mjs';
const lanes=['unit','formal','sdk'];
const hash=data=>createHash('sha256').update(data).digest('hex');
function files(directory){
  const result=[];
  function visit(dir){for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(dir,entry.name);if(lstatSync(path).isSymbolicLink())throw new Error('Artifact symlinks are not permitted');
    if(entry.isDirectory())visit(path);else if(entry.isFile())result.push(relative(directory,path));else throw new Error('Unsupported artifact entry');
  }}visit(directory);return result;
}
function git(args){const r=spawnSync('git',args,{cwd:ROOT,encoding:'utf8',env:sanitizeScriptEnv(),maxBuffer:32e6});if(r.error||r.status!==0)throw new Error('Cannot bind candidate inputs');return r.stdout.trim();}
/** Hosted runners float the Node 22 patch. Identity follows .nvmrc; the input digest still binds every source and dist byte. */
export function coverageNode(version=process.version,required=readFileSync(join(ROOT,'.nvmrc'),'utf8').trim()){
  const actual=version.replace(/^v/,'').split('.');
  const want=required.split('.').filter(Boolean);
  if(!want.length||want.some((part,index)=>actual[index]!==part))throw new Error(`Node ${version} does not match .nvmrc ${required}`);
  return want.join('.');
}
export function currentIdentity(){
  if(!process.env.GITHUB_RUN_ID||!process.env.GITHUB_RUN_ATTEMPT)throw new Error('Coverage reuse requires run and attempt identity');
  const names=git(['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean).sort();
  const digest=createHash('sha256');
  for(const name of new Set(names))digest.update(name).update('\0').update(readFileSync(join(ROOT,name))).update('\0');
  // Score compiled V8 against the very same compiled bytes/maps, not just a git ref.
  for(const group of ['packages','apps'])for(const workspace of readdirSync(join(ROOT,group)).sort()){
    const dist=join(ROOT,group,workspace,'dist');let stat;try{stat=lstatSync(dist);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    if(stat.isDirectory())for(const name of files(dist))digest.update(relative(ROOT,join(dist,name))).update('\0').update(readFileSync(join(dist,name))).update('\0');
  }
  return {candidate:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,
    inputs:digest.digest('hex'),root:resolve(ROOT),node:coverageNode(),platform:process.platform,arch:process.arch};
}
function validateContents(directory,lane,names){
  const result=`results/${lane}.xml`;if(!names.includes(result))throw new Error(`Missing ${lane} JUnit evidence`);
  const xml=readFileSync(join(directory,result),'utf8');
  const cases=parseJUnit(xml);
  if(!/<\/testsuites?>\s*$/.test(xml)||!cases.length||cases.some(c=>c.outcome==='failed')
    ||/<testsuites?\b[^>]*\b(?:failures|errors)=["'][1-9]/.test(xml))throw new Error('Invalid or failed JUnit evidence');
  const coverage=lane==='sdk'?names.filter(n=>n==='vitest/coverage-final.json'):names.filter(n=>n.startsWith('node/')&&n.endsWith('.json'));
  if(!coverage.length)throw new Error(`Missing ${lane} coverage evidence`);
  for(const file of coverage){const data=JSON.parse(readFileSync(join(directory,file),'utf8'));
    if(lane==='sdk'?!data||Array.isArray(data)||!Object.keys(data).length:!Array.isArray(data.result)||!data.result.length)throw new Error('Invalid coverage evidence');
  }
  if(lane!=='sdk'){
    const file=`flaky/${lane}.json`;if(!names.includes(file))throw new Error('Missing first-pass evidence');
    const report=JSON.parse(readFileSync(join(directory,file),'utf8'));
    if(report.pass!==true||report.firstExitCode!==0||report.flaky?.length||report.failed?.length)throw new Error('Failed or flaky first-pass evidence');
  }
}
export function writeBundle({directory,lane,identity,inventory,elapsedSeconds}){
  if(!lanes.includes(lane)||!Array.isArray(inventory)||!inventory.length||new Set(inventory).size!==inventory.length)throw new Error('Invalid lane inventory');
  if(!Number.isFinite(elapsedSeconds)||elapsedSeconds<0)throw new Error('Invalid lane duration');
  const names=files(directory).filter(f=>f!=='manifest.json');validateContents(directory,lane,names);
  const bundle={schema:1,lane,identity,inventory:[...inventory].sort(),elapsedSeconds,files:Object.fromEntries(names.map(f=>[f,hash(readFileSync(join(directory,f)))]))};
  writeFileSync(join(directory,'manifest.json'),JSON.stringify(bundle,null,2)+'\n');return bundle;
}
export function readBundles({directory,identity,expected}){
  const bundles={};const owners=new Set();
  for(const lane of lanes){
    if(!Array.isArray(expected[lane])||!expected[lane].length)throw new Error('Missing expected scope');
    for(const file of expected[lane]){if(owners.has(file))throw new Error('Overlapping inventory scope');owners.add(file);}
    const dir=join(directory,lane);const b=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
    if(b.schema!==1||b.lane!==lane||JSON.stringify(b.identity)!==JSON.stringify(identity))throw new Error(`${lane} identity mismatch`);
    if(JSON.stringify(b.inventory)!==JSON.stringify([...expected[lane]].sort()))throw new Error(`${lane} inventory mismatch`);
    if(!Number.isFinite(b.elapsedSeconds)||b.elapsedSeconds<0)throw new Error('Invalid duration evidence');
    const actual=files(dir).filter(f=>f!=='manifest.json');
    if(JSON.stringify(actual.sort())!==JSON.stringify(Object.keys(b.files??{}).sort()))throw new Error('Artifact integrity: file set mismatch');
    for(const name of actual)if(hash(readFileSync(join(dir,name)))!==b.files[name])throw new Error(`Artifact digest integrity failure: ${lane}/${name}`);
    validateContents(dir,lane,actual);bundles[lane]=b;
  }
  return bundles;
}
export function prepareCoverage({directory,output,identity=currentIdentity(),expected=discoverTests()}){
  const bundles=readBundles({directory,identity,expected});
  // Fresh destination only: stale coverage from another invocation must not enter the merge.
  mkdirSync(output,{recursive:false});mkdirSync(join(output,'node'));
  for(const lane of ['unit','formal'])for(const name of Object.keys(bundles[lane].files).filter(n=>n.startsWith('node/')&&n.endsWith('.json'))){
    copyFileSync(join(directory,lane,name),join(output,'node',`${lane}-${name.slice(5).replaceAll('/','-')}`));
  }
  copyFileSync(join(directory,'sdk','vitest','coverage-final.json'),join(output,'vitest.json'));
  writeFileSync(join(output,'verified-inputs.json'),JSON.stringify(bundles,null,2)+'\n');
  console.log('Verified unit + Formal + SDK coverage; no test re-execution.');
  for(const lane of lanes)console.log(`${lane}: ${bundles[lane].elapsedSeconds.toFixed(2)} seconds; ${bundles[lane].inventory.length} files; ${identity.candidate}; attempt ${identity.attempt}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{if(process.argv.length!==4)throw new Error('Usage: validation-artifacts.mjs <bundles-directory> <fresh-output-directory>');prepareCoverage({directory:resolve(process.argv[2]),output:resolve(process.argv[3])});}
  catch(error){console.error(error.stack);process.exitCode=1;}
}
