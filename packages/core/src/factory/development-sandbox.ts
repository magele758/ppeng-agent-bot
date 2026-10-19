export interface SandboxInput{name:string;image:string;workspace:string;input:string;broker:string;tool:string;uid:number;readOnly?:boolean}
export function sandboxArguments(v:SandboxInput):string[]{
 if(!/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9._/:_-]*@sha256:[a-f0-9]{64})$/.test(v.image)||!Number.isSafeInteger(v.uid)||v.uid<1)throw Error('Pinned image and nonroot user required');
 if(!/^factory_[a-zA-Z0-9_-]+$/.test(v.name))throw Error('Invalid container name');
 for(const p of [v.workspace,v.input,v.broker,v.tool])if(!p.startsWith('/')||/[\x00-\x1f,]/.test(p))throw Error('Invalid isolated mount');
 return ['run','--name',v.name,'--network','none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit','128','--memory','2g','--cpus','2','--user',`${v.uid}:${v.uid}`,'--tmpfs','/tmp:rw,nosuid,nodev,size=128m','--mount',`type=bind,src=${v.workspace},dst=/workspace${v.readOnly?',readonly':''}`,'--mount',`type=bind,src=${v.input},dst=/input,readonly`,'--mount',`type=bind,src=${v.broker},dst=/broker,readonly`,'--mount',`type=bind,src=${v.tool},dst=/tools/claude,readonly`,'--workdir','/workspace',v.image];
}
