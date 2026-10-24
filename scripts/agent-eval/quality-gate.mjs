#!/usr/bin/env node
/** Consume artifacts produced by a trusted evaluation job, never Agent completion claims. */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, validateSuite, gradeTask, compareQuality, DEFAULT_POLICY } from './quality.mjs';
import { validateLiveGate } from './bot-quality.mjs';

export function verifyEvidence(directory, expected) {
 const dir=resolve(directory),read=name=>JSON.parse(readFileSync(join(dir,name),'utf8'));
 const index=read('evidence-index.json');
 for(const [name,digest] of Object.entries(index)){
  if(!/^[a-zA-Z0-9_.-]+\.json$/.test(name)||name==='evidence-index.json')throw Error('invalid evidence filename');
  if(hash(readFileSync(join(dir,name),'utf8'))!==digest)throw Error('evidence digest mismatch: '+name);
 }
 const manifest=read('manifest.json'),stored=read('report.json'),suite=validateSuite(read('suite.json'));
 if(hash(suite)!==manifest.suiteHash)throw Error('suite fingerprint mismatch');
 const required=['manifest.json','suite.json','report.json'];
 const records=[];
 if(!Number.isInteger(manifest.trials)||manifest.trials<1||manifest.trials>20)throw Error('invalid trial count');
 for(const task of suite)for(let trial=0;trial<manifest.trials;trial++)for(const variant of ['baseline','candidate']){
  const filename=task.id+'-'+trial+'-'+variant+'.json';required.push(filename);
  const record=read(filename);
  if(record.caseId!==task.id||record.trial!==trial||record.variant!==variant)throw Error('record identity mismatch');
  if(record.skipped||!record.model||!['openai-compatible','anthropic-compatible'].includes(record.model.provider)||!(record.modelCalls>0))throw Error('not a real model trial');
  const graded=gradeTask(task,record);
  if(graded.pass!==record.pass||hash(graded.failures)!==hash(record.failures))throw Error('stored grade mismatch');
  records.push({...record,...graded});
 }
 if(hash(Object.keys(index).sort())!==hash(required.sort()))throw Error('incomplete or unexpected indexed artifacts');
 const jsonFiles=readdirSync(dir).filter(f=>f.endsWith('.json')&&f!=='evidence-index.json');
 if(hash(jsonFiles.sort())!==hash(required.sort()))throw Error('unexpected evidence records');
 if(new Set(records.map(r=>hash(r.model))).size!==1)throw Error('model identity differs between trials');
 // A caller cannot certify by lowering the minimum sample size or widening margins.
 const p=stored.policy??{};
 for(const key of Object.keys(DEFAULT_POLICY)){
  if(typeof p[key]!==typeof DEFAULT_POLICY[key])throw Error('missing gate policy');
  const minimum=['minCases','minTrials','minBaselinePassRate'].includes(key);
  if(key==='requireUsage' ? p[key]!==true : minimum ? p[key]<DEFAULT_POLICY[key] : p[key]>DEFAULT_POLICY[key])throw Error('weakened gate policy: '+key);
 }
 const recomputed=compareQuality(suite,records,{trials:manifest.trials,policy:p});
 validateLiveGate(manifest,{...recomputed,control:stored.control},expected);
 if(stored.verdict!==recomputed.verdict||stored.promotionEligible!==recomputed.promotionEligible)throw Error('report verdict mismatch');
 return recomputed;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args={};for(let i=2;i<process.argv.length;i+=2){if(!['--run','--candidate-sha','--baseline-sha'].includes(process.argv[i])||!process.argv[i+1])throw Error('Usage: quality-gate.mjs --run directory --candidate-sha SHA --baseline-sha SHA');args[process.argv[i].slice(2)]=process.argv[i+1];}
 try{const report=verifyEvidence(args.run,{candidateSha:args['candidate-sha'],baselineSha:args['baseline-sha']});console.log('LIVE QUALITY GATE PASSED: '+report.verdict);}
 catch(error){console.error('LIVE QUALITY GATE BLOCKED: '+error.message);process.exitCode=1;}
}
