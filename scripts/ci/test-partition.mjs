// One owner per Node test file. The local test:unit command remains the source of scope.
import {globSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {splitNodeTestCommand} from './flaky-retry-lib.mjs';
export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const FORMAL_REGRESSION_TESTS=[
  'packages/core/test/formal-invariants.test.js',
  'packages/core/test/mock-llm-e2e.test.js',
  'packages/core/test/goal-state-machine.test.js',
  'packages/core/test/session-surface.test.js'
];
export function partitionTests(files,read=f=>readFileSync(resolve(ROOT,f),'utf8')){
  if(new Set(files).size!==files.length)throw new Error('Duplicate test ownership');
  const plan={unit:[],formal:[]};
  for(const file of [...files].sort()){
    // Imports, not arbitrary mentions in workflow-policy test strings. New direct
    // verifier clients are moved automatically, rather than falling off an allowlist.
    const parsed=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true);
    let formal=FORMAL_REGRESSION_TESTS.includes(file);
    function visit(node){
      const spec=ts.isImportDeclaration(node)?node.moduleSpecifier:
        ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:undefined;
      if(spec&&ts.isStringLiteral(spec)&&spec.text.includes('/formal/'))formal=true;
      ts.forEachChild(node,visit);
    }
    visit(parsed);
    plan[formal?'formal':'unit'].push(file);
  }
  return plan;
}
export function discoverTests({root=ROOT,command}={}){
  const script=command??JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).scripts['test:unit'];
  const {flags,patterns}=splitNodeTestCommand(script);
  const files=[];
  for(const raw of patterns){
    const pattern=raw.replace(/^(['"])(.*)\1$/,'$2');
    if(!/^[\w./*?-]+$/.test(pattern))throw new Error('Unsupported test pattern');
    const matches=globSync(pattern,{cwd:root});
    if(!matches.length)throw new Error(`Empty test scope: ${pattern}`);
    files.push(...matches);
  }
  const plan=partitionTests(files,f=>readFileSync(resolve(root,f),'utf8'));
  for(const file of FORMAL_REGRESSION_TESTS)if(!plan.formal.includes(file))throw new Error(`Missing formal scope: ${file}`);
  return {...plan,flags,sdk:globSync('packages/agent-loop/src/**/*.test.ts',{cwd:root}).sort()};
}
