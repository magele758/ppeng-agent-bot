/** Offline planning only. Content deduplication cannot certify semantic independence. */
import { DEFAULT_POLICY, validateSuite, compareQuality, pairedSummary, hash } from './quality.mjs';

function tiedSummary(n, family) {
 return pairedSummary(Array.from({length:n},()=>({baselineReliable:true,candidateReliable:true,baselineRate:1,candidateRate:1})),family);
}
function requiredTiedTasks(margin,family) {
 // Wilson's all-tied lower bound is -z²/(n+z²); derive z² from n=1.
 const width=-tiedSummary(1,family).deltaInterval[0];
 if(margin===0)return null;
 return Math.max(1,Math.ceil(width/(1-width)*(1-margin)/margin));
}
function canonical(value) {
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
export function planQuality(suite,{trials=3,policy={}}={}) {
 validateSuite(suite);
 compareQuality(suite,[],{trials,policy});
 const p={...DEFAULT_POLICY,...policy}, groups=new Map();
 for(const task of suite){
  const {id,category,critical,...content}=task;
  const key=hash(canonical(content));
  const group=groups.get(key)??[];group.push(task);groups.set(key,group);
 }
 const duplicateGroups=[...groups.values()].filter(g=>g.length>1).map(g=>g.map(t=>t.id));
 const names=[...new Set(suite.map(t=>t.category))],family=names.length+1;
 const categories=Object.fromEntries(names.map(name=>{
  const n=[...groups.values()].filter(g=>g.some(t=>t.category===name)).length;
  return [name,{distinctTasks:n,tiedInterval:tiedSummary(n,family).deltaInterval,requiredTiedTasks:requiredTiedTasks(p.maxCategoryDrop,family)}];
 }));
 const overall=tiedSummary(groups.size,family);
 return {independenceCertified:false,duplicateGroups,categories,distinctTasks:groups.size,
  minimumWorkerRuns:suite.length*trials*2,
  tiedPromotionEstablished:duplicateGroups.length===0&&groups.size>=p.minCases&&trials>=p.minTrials&&overall.deltaInterval[0]>=-p.nonInferiorityMargin&&Object.values(categories).every(c=>c.tiedInterval[0]>=-p.maxCategoryDrop),
  overallTiedInterval:overall.deltaInterval,
  note:'Planning only: all-tied sample size is not a power guarantee. Exact-content duplicates are detected; distinct content still requires semantic independence review. No promotion authorization.'};
}
