import { ValidationError } from '../errors.js';
import { policyRevision } from './development-evidence.js';
import type { DevelopmentPolicy } from './development-types.js';
const fail=(s:string):never=>{throw new ValidationError(s);};
function str(v:any,max=2048):string{return typeof v==='string'&&v.trim()&&v.length<=max&&!/[\x00-\x1f]/.test(v)?v:fail('Invalid development string');}
function list(v:any):string[]{if(!Array.isArray(v)||v.length>100)fail('Invalid development list');return v.map((x:any)=>str(x));}
function bounded(v:any,min:number,max:number):number{return Number.isInteger(v)&&v>=min&&v<=max?v:fail('Invalid development limit');}
function commands(v:any):string[]{const a=list(v);if(!a.length)fail('Missing command');return a;}
export function parseDevelopmentPolicy(input:any):DevelopmentPolicy{
 if(!input||typeof input!=='object')fail('Invalid development policy');
 const image=str(input.image);if(!/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(image))fail('Pinned image digest required');
 const toolPath=str(input.toolPath);if(!toolPath.startsWith('/')||toolPath.includes(','))fail('Absolute tool path required');
 const u=new URL(str(input.modelUrl));if((u.protocol!=='https:'&&!privateHttp(u))||u.username||u.password||u.search||u.hash)fail('HTTPS or explicitly configured private HTTP model URL required');
 const checks=parseChecks(input.checks);const redCheck=str(input.redCheck);if(!checks.some((c:any)=>c.id===redCheck&&c.required))fail('Required red check missing');
 const criteria=parseCriteria(input.criteria);
 const p={enabled:input.enabled===true,allowedUserIds:list(input.allowedUserIds),image,toolPath,model:str(input.model),modelUrl:u.toString().replace(/\/$/,''),credentialRef:str(input.credentialRef,100),codeArgv:commands(input.codeArgv),reviewArgv:commands(input.reviewArgv),checks,redCheck,install:commands(input.install),timeoutMs:bounded(input.timeoutMs,1000,86400000),maxRounds:bounded(input.maxRounds??6,0,20),maxRetries:bounded(input.maxRetries??1,0,3),minDiskMb:bounded(input.minDiskMb??1024,128,1048576),maxWorkspaceMiB:bounded(input.maxWorkspaceMiB??1024,128,65536),criteria,criteriaApproved:input.criteriaApproved===true,baselineFailures:list(input.baselineFailures??[])};
 return {...p,revision:policyRevision(p)};
}
function parseChecks(v:any){if(!Array.isArray(v)||!v.length||v.length>30)fail('Required checks missing');const ids=new Set();return v.map((c:any)=>{const id=str(c.id,80);if(ids.has(id))fail('Duplicate check');ids.add(id);return {id,argv:commands(c.argv),required:c.required!==false};});}
function parseCriteria(v:any){if(!Array.isArray(v)||!v.length||v.length>100)fail('Approved criteria missing');const ids=new Set();return v.map((c:any)=>{const id=str(c.id,80);if(ids.has(id))fail('Duplicate criterion');ids.add(id);return {id,given:str(c.given),when:str(c.when),then:str(c.then)};});}

function privateHttp(u:URL){if(u.protocol!=='http:')return false;if(['localhost','127.0.0.1','[::1]'].includes(u.hostname))return true;const parts=u.hostname.split('.').map(Number);return parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(parts[0]===10||(parts[0]===192&&parts[1]===168)||(parts[0]===172&&parts[1]!>=16&&parts[1]!<=31));}
