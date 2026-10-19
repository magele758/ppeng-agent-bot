import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { MUTATIONS } from './lifecycle-mutations.mjs';
let config;
export function initialize(data) { config = data; }
export async function load(url, context, nextLoad) {
  const mutation = MUTATIONS[config?.mutation];
  if (!mutation || url !== pathToFileURL(join(config.root, mutation.file.replace('/src/', '/dist/').replace(/\.ts$/, '.js'))).href) return nextLoad(url, context);
  const ts = await import('typescript');
  if (ts.version !== '5.9.3') throw new Error('TypeScript 5.9.3 required');
  const source = readFileSync(join(config.root, mutation.file), 'utf8');
  if (source.split(mutation.from).length !== 2) throw new Error('Mutation anchor drift');
  const compiled = ts.transpileModule(source.replace(mutation.from, mutation.to), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  process.stderr.write(`LIFECYCLE_MUTATION_LOADED:${config.mutation}\n`);
  return { format: 'module', source: compiled.outputText, shortCircuit: true };
}
