import test from 'node:test';
import assert from 'node:assert/strict';
import {networkEdges} from './network-observations.ts';
import {intervalUnit} from './interval-unit.ts';
test('真实委派去重且群参与不产生虚假委派 [AC:bot-network-and-schedule-list#AC-1]',()=>{
 const t={id:'t',from:'a',to:'b',title:'inspect',state:'completed',at:'today',session:'child'};
 const member={...t,id:'r/b',from:'room',to:'b'};
 const edges=networkEdges([t,t,member,{...t,id:'self',to:'a'}]);
 assert.deepEqual(edges.map(e=>[e.from,e.to,e.records.length]),[['a','b',1],['room','b',1]]);
 assert.equal(edges[0].records[0].session,'child');
});
test('间隔按可整除单位显示且保留精度 [AC:bot-network-and-schedule-list#AC-2]',()=>{
 assert.deepEqual(intervalUnit('7200000'),{unit:'hour',count:2});
 assert.deepEqual(intervalUnit('90000'),{unit:'second',count:90});
 assert.deepEqual(intervalUnit('1500'),{unit:'second',count:1.5});
});
