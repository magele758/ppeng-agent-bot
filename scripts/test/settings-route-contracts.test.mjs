import test from 'node:test';
import assert from 'node:assert/strict';
import { loopRoutes } from '../../apps/daemon/dist/routes/loop.js';
import { compactRoutes } from '../../apps/daemon/dist/routes/compact.js';
import { modelFallbackRoutes } from '../../apps/daemon/dist/routes/model-fallback.js';
import { toolExposureRoutes } from '../../apps/daemon/dist/routes/tool-exposure.js';
function fixture(routes) {
 const data = new Map();
 const store = { getDaemonControl: k => structuredClone(data.get(k)), setDaemonControl: (k,v) => data.set(k,structuredClone(v)), getAgent: id => id === 'general' ? {id} : undefined };
 const handler = routes({store}).find(r => r.method === 'PATCH').handler;
 return async body => { let result; const response = {setHeader(){},end(text){result=JSON.parse(text);}}; await handler({readBody:async()=>body,response});assert.equal(response.statusCode,200);return result; };
}
test('loop settings PATCH persists valid policies and rejects invalid updates',async()=>{
 const patch=fixture(loopRoutes);
 const valid={steerDrainPolicy:'next_shot_only',inboxOverflowCap:3,defaultTaskMode:'browser',defaultSkillScope:'requested',steerInterruptPolicy:'queue',kernelVariant:'ppeng',assemblyPreset:'full',repeatGuard:'off',engineEnabled:true};
 assert.equal((await patch(valid)).settings.inboxOverflowCap,3);
 assert.equal((await patch({defaultTaskMode:'standard',inboxOverflowCap:0})).settings.defaultTaskMode,'auto');
 await patch({}); await patch(null);
 for(const key of Object.keys(valid))await assert.rejects(patch({[key]:'invalid'}));
});
test('compact PATCH preserves settings and validates every option',async()=>{
 const patch=fixture(compactRoutes);
 assert.equal((await patch({policy:'keep_recent',keepRecent:4,enabled:true})).settings.keepRecent,4);
 await patch({});await patch(null);
 for(const key of ['policy','keepRecent','enabled'])await assert.rejects(patch({[key]:'invalid'}));
});
test('fallback PATCH supports empty chain, enablement and rejects malformed updates',async()=>{
 const patch=fixture(modelFallbackRoutes);
 await patch({chain:[],enabled:false});await patch({enabled:true});await patch({chain:[]});
 for(const body of [null,{},'invalid',{enabled:'yes'},{chain:'bad'}])await assert.rejects(patch(body));
});
test('tool exposure PATCH persists modes and groups without accepting unknown identities',async()=>{
 const patch=fixture(toolExposureRoutes);
 assert.equal((await patch({mode:'full'})).settings.mode,'full');
 assert.deepEqual((await patch({mode:'progressive',agentId:'general',groups:['extensions','extensions']})).settings.pinnedGroups.general,['extensions']);
 await patch({});
 for(const body of [null,'bad',{mode:'bad'},{groups:[]},{agentId:'missing',groups:[]},{agentId:'general',groups:['bad']},{agentId:'general',groups:'bad'}])await assert.rejects(patch(body));
});
