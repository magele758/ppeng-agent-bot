import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { MUTATIONS } from './restart-mutations.mjs';
let config;
export function initialize(data){config=data;}
export async function load(url,context,nextLoad){
  const m=MUTATIONS[config?.mutation];
  if(!m||url!==pathToFileURL(join(config.root,m.file.replace('/src/','/dist/').replace(/\.ts$/,'.js'))).href)return nextLoad(url,context);
  const ts=await import('typescript');if(ts.version!=='5.9.3')throw new Error('TypeScript 5.9.3 required');
  const source=readFileSync(join(config.root,m.file),'utf8');if(source.split(m.from).length!==2)throw new Error('Restart mutation anchor drift');
  process.stderr.write(`RESTART_MUTATION_LOADED:${config.mutation}\n`);
  return {format:'module',source:ts.transpileModule(source.replace(m.from,m.to),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText,shortCircuit:true};
}
