#!/usr/bin/env node
import{mkdirSync,writeFileSync}from'node:fs';
import{join,resolve}from'node:path';
import{ROOT,runConcurrencyProcess}from'./concurrency-verifier.mjs';
const args=process.argv.slice(2);
if(args.length&&(args.length!==2||args[0]!=='--out')){console.error('Usage: pnpm run test:concurrency [--out directory]');process.exit(2);}
const out=args.length?resolve(args[1]):join(ROOT,'coverage/formal/concurrency');
const report=runConcurrencyProcess();
const lines=['# Multiprocess session verification','',`Overall: **${report.status}** (exit ${report.exitCode})`,
`Bounded design model: ${report.model?.status??'incomplete'}; states=${report.model?.states??0}; transitions=${report.model?.transitions??0}`,
`Real concurrent processes: ${report.runtime?.status??'incomplete'}; completed=${report.runtime?.completed??false}; scenarios=${report.runtime?.scenarios.length??0}`,
`Isolated real source faults: ${report.mutations?.status??'incomplete'}; restored=${report.mutations?.restored??false}`,
`Existing restart/lifecycle/pairing: ${['restart','lifecycle','pairing'].map(k=>report.existing?.[k]?.status??'incomplete').join('/')}`,
`Source mapping: ${report.review?.status??'incomplete'}`,'',
'Production RawAgentRuntime and SQLite execute in distinct, overlapping OS processes. IPC and read-only observation cuts control schedule; only model/tool I/O is simulated. No direct SQL state reconstruction. This is bounded verification, not an unbounded proof or full daemon HTTP/E2E test.',''];
if(report.scope)lines.push('## Scope','',JSON.stringify(report.scope.bounds),'',...report.scope.assumptions.map(s=>'- Assumption: '+s),...report.scope.exclusions.map(s=>'- Excluded: '+s),'');
if(report.reason)lines.push(report.reason);
for(const s of report.runtime?.scenarios??[]){lines.push(`- ${s.name}: ${s.status}`);if(s.status!=='pass'){lines.push('  - Order: '+s.events.join(' → '));if(s.reason)lines.push('  - '+s.reason);for(const c of s.checks.filter(c=>!c.ok))lines.push(`  - ${c.criterion}: ${c.label}; expected=${JSON.stringify(c.expected)}; actual=${JSON.stringify(c.actual)}`);}}
for(const m of report.mutations?.mutants??[])lines.push(`- Mutation ${m.name}: ${m.killed?'caught':'MISSED'}; loaded=${m.loaded}; source unchanged=${m.sourceUnchanged}`);
for(const p of report.review?.changed??[])lines.push('- Needs review: '+p);
try{mkdirSync(out,{recursive:true});writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');writeFileSync(join(out,'report.md'),lines.join('\n')+'\n');}catch(e){console.error('Cannot preserve evidence: '+e.message);process.exit(2);}
console.log(lines.slice(0,8).join('\n'));console.log('Evidence: '+join(out,'report.md'));process.exitCode=report.exitCode;
