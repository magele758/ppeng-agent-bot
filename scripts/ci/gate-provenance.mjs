import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
const result=spawnSync('git',['rev-parse','HEAD^{tree}'],{env:sanitizeScriptEnv(),encoding:'utf8'});
if(result.status!==0)throw new Error('Cannot identify measured candidate tree');
const out=process.argv[2];if(!out)throw new Error('Usage: gate-provenance.mjs <output.json>');
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,JSON.stringify({schema:1,candidate:result.stdout.trim(),node:process.version,
  environment:JSON.stringify({image:process.env.ImageOS??process.platform,imageVersion:process.env.ImageVersion??'local',arch:process.arch}),
  scope:['build','functional-unit','coverage-unit','sdk-coverage','crap','bot-faults','package','formal','capability-contracts','evaluator','http-regression','integration','browser','full-mutation','acceptance'],
  runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT},null,2)+'\n');
