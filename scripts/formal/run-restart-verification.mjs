#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, runRestartProcess } from './restart-verifier.mjs';
const args=process.argv.slice(2);
if(args.length&&(args.length!==2||args[0]!=='--out')){console.error('Usage: npm run test:restart -- [--out directory]');process.exit(2);}
const out=args.length?resolve(args[1]):join(ROOT,'coverage/formal/restart');
const report=runRestartProcess();
const lines=['# Process restart recovery verification','',`Overall: **${report.status}** (exit ${report.exitCode})`,
`Bounded design model: ${report.model?.status??'not completed'}; states=${report.model?.states??0}; transitions=${report.model?.transitions??0}`,
`Real process restart: ${report.runtime?.status??'not completed'}; completed=${report.runtime?.completed??false}`,
`Isolated source faults: ${report.mutations?.status??'not completed'}; restored=${report.mutations?.restored??false}`,
`Existing lifecycle: ${report.existing?.lifecycle?.status??'not completed'}; pairing: ${report.existing?.pairing?.status??'not completed'}`,
`Source review: ${report.review?.status??'not completed'}`,'',
'Actual runtime service processes use production RawAgentRuntime construction, SQLite, default kernel and destroy(). The HTTP server and daemon HTTP-drain timeout are not exercised. Model/tool I/O and IPC phase observation are controlled; lifecycle and persistence behavior are not replaced.',
'Bounded model success does not prove product recovery success.',''];
if(report.reason)lines.push(report.reason);
if(report.scope)lines.push('## Scope','',JSON.stringify(report.scope.bounds),'',...report.scope.assumptions.map(s=>'- Assumption: '+s),...report.scope.exclusions.map(s=>'- Excluded: '+s),'');
for(const s of report.runtime?.scenarios??[]){lines.push(`- ${s.name}: ${s.status}`);if(s.status!=='pass'){lines.push(`  - Order: ${s.events.join(' → ')}`);if(s.reason)lines.push('  - '+s.reason);for(const c of s.checks.filter(c=>!c.ok))lines.push(`  - ${c.criterion}: ${c.label}; expected=${JSON.stringify(c.expected)}; actual=${JSON.stringify(c.actual)}`);}}
for(const m of report.mutations?.mutants??[])lines.push(`- Mutation ${m.name}: ${m.killed?'caught':'MISSED'}; loaded=${m.loaded}`);
for(const p of report.review?.changed??[])lines.push('- Needs review: '+p);
try{mkdirSync(out,{recursive:true});writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');writeFileSync(join(out,'report.md'),lines.join('\n')+'\n');}catch(e){console.error('Cannot preserve evidence: '+e.message);process.exit(2);}
console.log(lines.slice(0,8).join('\n'));console.log('Evidence: '+join(out,'report.md'));process.exitCode=report.exitCode;
