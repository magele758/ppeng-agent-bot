import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillCaptureService, SkillProposalStore, buildSkillProposeReminder } from '../dist/skill-proposals/index.js';
import { loadStateDirSkills } from '../dist/skills/builtin-skills.js';

const suggestion = { name: 'release-check', description: 'Verify releases', reason: 'The release workflow succeeded', summary: 'Check build and health endpoint' };
function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-capture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const deps = {
    stateDir: dir,
    settingsStore: { getDaemonControl: () => ({ enabled: true, remindEveryNToolCalls: 10 }) },
    listSkills: () => loadStateDirSkills(dir),
    getEvidence: () => 'User requested release verification. Build and health check passed.',
    complete: async () => { calls++; return JSON.stringify({ description: 'Verify releases', body: '# Release\n1. Build.\n2. Check health.' }); },
    reloadSkills: async () => {},
    ...overrides
  };
  return { dir, service: new SkillCaptureService(deps), calls: () => calls, deps };
}
test('reminders leave judgment to model and create no suggestion [AC:skill-capture-intent-confirmation#AC-1]', t => {
  const { service, deps } = setup(t);
  const input = { settingsStore: deps.settingsStore, agent: {}, session: { metadata: {} } };
  assert.equal(buildSkillProposeReminder({ ...input, turn: 9 }), '');
  assert.match(buildSkillProposeReminder({ ...input, turn: 10 }), /confirmation/i);
  assert.deepEqual(service.list('s1'), []);
});
test('suggestion stores intent only, deduplicates rejection, cannot cross session [AC:skill-capture-intent-confirmation#AC-2] [AC:skill-capture-intent-confirmation#AC-4]', async t => {
  const { service, dir, calls } = setup(t);
  const s = await service.suggest('s1', 'bot', suggestion);
  assert.equal(s.status, 'pending'); assert.equal(s.kind, 'new'); assert.equal(s.reason, suggestion.reason);
  assert.equal(s.body, undefined); assert.equal(calls(), 0); assert.equal(existsSync(join(dir, 'skills')), false);
  await assert.rejects(service.confirm('s2', s.id), /not found/);
  service.reject('s1', s.id);
  const again = await service.suggest('s1', 'bot', suggestion);
  assert.equal(again.id, s.id); assert.equal(again.status, 'rejected'); assert.equal(calls(), 0);
});
test('one confirmation distills installs and is idempotent [AC:skill-capture-intent-confirmation#AC-3] [AC:skill-capture-intent-confirmation#AC-5]', async t => {
  const { service, dir, calls } = setup(t);
  const s = await service.suggest('s1', 'bot', suggestion);
  const [a,b] = await Promise.all([service.confirm('s1',s.id), service.confirm('s1',s.id)]);
  assert.equal(a.status, 'saved'); assert.equal(b.status, 'saved'); assert.equal(calls(), 1);
  assert.equal((await service.confirm('s1',s.id)).status, 'saved'); assert.equal(calls(),1);
  assert.ok((await loadStateDirSkills(dir)).some(s=>s.name===suggestion.name));
  assert.equal(new SkillProposalStore(dir).list({status:'pending'}).length,0);
});
test('failed update preserves previous skill, legacy reviews and revoke stay available [AC:skill-capture-intent-confirmation#AC-5] [AC:skill-capture-intent-confirmation#AC-6]', async t => {
  const { service, dir } = setup(t, { complete: async () => { throw Error('model unavailable'); } });
  const store = new SkillProposalStore(dir);
  const old = store.create({...suggestion, body:'# Original',sessionId:'legacy'});
  store.approve(old.id);
  const path=join(dir,'skills',suggestion.name,'SKILL.md'); const before=readFileSync(path,'utf8');
  const s=await service.suggest('s1','bot',suggestion); assert.equal(s.kind,'update');
  const result=await service.confirm('s1',s.id); assert.equal(result.status,'failed'); assert.match(result.error,/model unavailable/);
  assert.equal(readFileSync(path,'utf8'),before);
  store.revoke(old.id); assert.equal(existsSync(path),false);
  const pending=store.create({...suggestion,body:'# Legacy',sessionId:'legacy'});store.reject(pending.id);assert.equal(store.get(pending.id).status,'rejected');
});
test('confirmation authorizes only fixed target and handles invalid output', async t => {
  const {service,dir}=setup(t,{complete:async()=>JSON.stringify({name:'other-skill',description:'bad',body:'# Bad'})});
  const s=await service.suggest('s1','bot',suggestion); const result=await service.confirm('s1',s.id);
  assert.equal(result.status,'failed'); assert.equal(existsSync(join(dir,'skills')),false);
});

test('confirmed update replaces only its target and can be revoked [AC:skill-capture-intent-confirmation#AC-3] [AC:skill-capture-intent-confirmation#AC-6]', async t => {
  const {service,dir}=setup(t);
  const proposals=new SkillProposalStore(dir);
  const old=proposals.create({...suggestion,body:'# Before',sessionId:'legacy'});proposals.approve(old.id);
  const s=await service.suggest('s1','bot',suggestion);
  assert.equal(s.kind,'update');
  const saved=await service.confirm('s1',s.id);
  assert.equal(saved.status,'saved');
  assert.match(readFileSync(join(dir,'skills',suggestion.name,'SKILL.md'),'utf8'),/Check health/);
  proposals.revoke(saved.proposalId);
  assert.equal((await loadStateDirSkills(dir)).length,0);
});
test('concurrent target changes and failed installation preserve prior content [AC:skill-capture-intent-confirmation#AC-5]', async t => {
  const {service,dir}=setup(t);
  const s=await service.suggest('s1','bot',suggestion);
  const store=new SkillProposalStore(dir);
  const newer=store.create({...suggestion,body:'# Changed by another review',sessionId:'other'});store.approve(newer.id);
  const failed=await service.confirm('s1',s.id);
  assert.equal(failed.status,'failed');assert.match(failed.error,/changed/);
  const path=join(dir,'skills',suggestion.name,'SKILL.md');const before=readFileSync(path,'utf8');
  const update=store.create({...suggestion,body:'# Should not remain',sessionId:'other'});
  store.write=()=>{throw Error('disk full')};
  assert.throws(()=>store.approve(update.id),/disk full/);
  assert.equal(readFileSync(path,'utf8'),before);
});
test('completed capture and rejection survive service restart', async t => {
  const {service,deps,calls}=setup(t);
  const s=await service.suggest('s1','bot',suggestion);
  const saved=await service.confirm('s1',s.id);
  const restarted=new SkillCaptureService(deps);
  assert.equal((await restarted.confirm('s1',s.id)).proposalId,saved.proposalId);assert.equal(calls(),1);
  const other=await restarted.suggest('s2','bot',{...suggestion,name:'another-skill'});
  restarted.reject('s2',other.id);
  const next=new SkillCaptureService(deps);
  assert.equal((await next.suggest('s2','bot',{...suggestion,name:'another-skill'})).status,'rejected');
});

test('successful install remains successful if the final status write fails', async t => {
  const {service,dir,calls}=setup(t);
  const s=await service.suggest('s1','bot',suggestion);
  const write=service.write.bind(service);
  service.write=record=>{if(record.status==='saved')throw Error('status disk full');return write(record)};
  const saved=await service.confirm('s1',s.id);
  assert.equal(saved.status,'saved');assert.equal(calls(),1);
  assert.equal(service.list('s1')[0].status,'saved');
  assert.ok((await loadStateDirSkills(dir)).some(s=>s.name===suggestion.name));
});
test('shutdown cancels pending distillation without installing a skill', async t => {
  let started;
  const ready=new Promise(resolve=>{started=resolve});
  const {service,dir}=setup(t,{complete:async()=>{started();return new Promise(()=>{})}});
  const s=await service.suggest('s1','bot',suggestion);
  const result=service.confirm('s1',s.id);
  await ready;await service.close();
  assert.equal((await result).status,'failed');assert.equal(existsSync(join(dir,'skills')),false);
});
