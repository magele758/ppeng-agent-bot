import test from 'node:test';
import assert from 'node:assert/strict';
import { routineStatusPresentation } from './routine-status.ts';
import { botWork as zh } from './i18n/messages/zh/botWork.ts';
import { botWork as en } from './i18n/messages/en/botWork.ts';
test('routine panel distinguishes silent skipped unknown in both locales [AC:bot-routine-lifecycle#AC-11]',()=>{
 const states=['silent','skipped','unknown'] as const;
 const styles=states.map(s=>routineStatusPresentation(s).style);
 assert.equal(new Set(styles.map(s=>JSON.stringify(s))).size,3);
 for(const locale of [zh,en]){
  const labels=states.map(s=>locale.states[s]);assert.equal(new Set(labels).size,3);
  for(const s of states){assert.equal(routineStatusPresentation(s).key,`botWork.states.${s}`);assert.notEqual(locale.states[s],locale.states.completed);assert.notDeepEqual(routineStatusPresentation(s).style,routineStatusPresentation('completed').style);}
 }
 assert.equal(routineStatusPresentation('unexpected').key,'botWork.states.unknown');
});

test('BotCronPanel run history uses the shared localized status presentation [AC:bot-routine-lifecycle#AC-11]',async()=>{
 const {readFileSync}=await import('node:fs');
 const source=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
 assert.match(source('../components/BotCronPanel.tsx'),/<RoutineRuns jobId=/);
 assert.match(source('../components/bot-work/RoutineRuns.tsx'),/<Status value={r.status}/);
 assert.match(source('../components/bot-work/shared.tsx'),/routineStatusPresentation\(value\)/);
 assert.match(source('../components/bot-work/shared.tsx'),/style={presentation.style}>{t\(presentation.key\)}/);
});
