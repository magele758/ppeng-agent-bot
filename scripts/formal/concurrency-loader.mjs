import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { MUTATIONS, CUTS } from './concurrency-mutations.mjs';
let config;
export function initialize(data){config=data;}
export async function load(url,context,nextLoad){
  const dist=p=>pathToFileURL(join(config.root,p.replace('/src/','/dist/').replace(/\.ts$/,'.js'))).href;
  const m=MUTATIONS[config?.mutation];
  const cuts=CUTS.filter(c=>url===dist(c.file));
  if(!cuts.length&&(!m||url!==dist(m.file)))return nextLoad(url,context);
  const ts=await import('typescript');if(ts.version!=='5.9.3')throw new Error('TypeScript 5.9.3 required');
  const file=cuts[0]?.file??m.file;let source=readFileSync(join(config.root,file),'utf8');
  if(m&&url===dist(m.file)){if(source.split(m.from).length!==2)throw new Error('Concurrency mutation anchor drift');source=source.replace(m.from,m.to);process.stderr.write(`CONCURRENCY_MUTATION_LOADED:${config.mutation}\n`);}
  for(const cut of cuts){const n=source.split(cut.from).length-1; // approval update and expiry share guard; observe both without changing either.
    if(n<1)throw new Error('Observation anchor drift');source=source.replaceAll(cut.from,cut.to);}
  return {format:'module',source:ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText,shortCircuit:true};
}
