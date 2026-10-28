import type {Fact,WaitCondition} from './types.js';
const scalar=(v:unknown):v is Fact=>v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v));
export function validateCondition(value:unknown,fields:readonly string[],depth=0):asserts value is WaitCondition {
 if(depth>6||!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid wait condition');
 const c=value as Record<string,unknown>;
 if(c.op==='all'||c.op==='any'){
  if(!Array.isArray(c.conditions)||c.conditions.length<1||c.conditions.length>16)throw new Error('Invalid condition group');
  for(const child of c.conditions)validateCondition(child,fields,depth+1);
  return;
 }
 if(typeof c.field!=='string'||!fields.includes(c.field)||['__proto__','constructor','prototype'].includes(c.field))throw new Error('Invalid condition field');
 if(c.op==='changed')return;
 if(c.op==='in'&&Array.isArray(c.values)&&c.values.length>0&&c.values.length<=32&&c.values.every(scalar))return;
 if(['eq','ne','gte','lte'].includes(String(c.op))&&scalar(c.value)){
  if((c.op==='gte'||c.op==='lte')&&typeof c.value!=='number')throw new Error('Numeric condition required');
  return;
 }
 throw new Error('Invalid wait condition operator or value');
}
export function conditionMatches(condition:WaitCondition,facts:Record<string,Fact>,baseline?:Record<string,Fact>):boolean {
 if(condition.op==='all')return condition.conditions.every(c=>conditionMatches(c,facts,baseline));
 if(condition.op==='any')return condition.conditions.some(c=>conditionMatches(c,facts,baseline));
 if(!('field' in condition)||!Object.hasOwn(facts,condition.field))return false;
 const value=facts[condition.field];
 switch(condition.op){
  case 'changed':return !!baseline&&Object.hasOwn(baseline,condition.field)&&value!==baseline[condition.field];
  case 'eq':return value===condition.value;
  case 'ne':return value!==condition.value;
  case 'in':return condition.values.includes(value!);
  case 'gte':return typeof value==='number'&&typeof condition.value==='number'&&value>=condition.value;
  case 'lte':return typeof value==='number'&&typeof condition.value==='number'&&value<=condition.value;
 }
}
export const waitConditionSchema={type:'object',description:'Predicate: {op:eq|ne|gte|lte,field,value}, {op:in,field,values}, {op:changed,field}, or {op:all|any,conditions:[predicates]}. Missing facts never match.',properties:{op:{type:'string',enum:['eq','ne','gte','lte','in','changed','all','any']},field:{type:'string'},value:{type:['string','number','boolean','null']},values:{type:'array',items:{type:['string','number','boolean','null']}},conditions:{type:'array',items:{type:'object'}}},required:['op']};
