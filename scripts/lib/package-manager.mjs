import {existsSync,readFileSync,readdirSync,mkdirSync,symlinkSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';

/** Historical immutable revisions keep their own install contract; current pnpm never falls back. */
export function installationCommand(directory){
 if(existsSync(join(directory,'pnpm-lock.yaml')))return {command:'pnpm',args:['install','--frozen-lockfile']};
 if(existsSync(join(directory,'package-lock.json')))return {command:'npm',args:['ci']};
 throw new Error(`No supported frozen installation lock in ${directory}`);
}
function manifests(root){
 const files=[join(root,'package.json')];
 for(const group of ['apps','packages'])if(existsSync(join(root,group)))for(const dir of readdirSync(join(root,group),{withFileTypes:true})){
  const path=join(root,group,dir.name,'package.json');if(dir.isDirectory()&&existsSync(path))files.push(path);
 }
 return files;
}
function resolvedPackage(name,require){
 try{return dirname(require.resolve(`${name}/package.json`));}catch{}
 let path=dirname(require.resolve(name));
 while(dirname(path)!==path){
  const pkg=join(path,'package.json');if(existsSync(pkg)&&JSON.parse(readFileSync(pkg,'utf8')).name===name)return path;
  path=dirname(path);
 }
 throw new Error(`Cannot locate installed dependency ${name}`);
}
/**
 * Legacy source compiled against today's third-party toolchain, never today's workspace code.
 * Resolve declared dependencies from each pnpm workspace instead of assuming root hoisting.
 */
export function linkHistoricalDependencies(checkout,sourceRoot){
 const target=join(checkout,'node_modules');mkdirSync(target,{recursive:true});
 const link=(name,path)=>{const dest=join(target,name);if(existsSync(dest))return;mkdirSync(dirname(dest),{recursive:true});symlinkSync(path,dest,'junction');};
 for(const file of manifests(sourceRoot)){
  const pkg=JSON.parse(readFileSync(file,'utf8')),require=createRequire(file);
  for(const group of ['dependencies','devDependencies','optionalDependencies'])for(const name of Object.keys(pkg[group]??{})){
   if(name.startsWith('@ppeng/'))continue;
   try{link(name,resolvedPackage(name,require));}catch(error){if(group!=='optionalDependencies')throw error;}
  }
 }
 for(const file of manifests(checkout).slice(1)){
  const pkg=JSON.parse(readFileSync(file,'utf8'));if(pkg.name?.startsWith('@ppeng/'))link(pkg.name,resolve(dirname(file)));
 }
}
