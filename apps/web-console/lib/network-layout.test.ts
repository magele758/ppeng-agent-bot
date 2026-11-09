import test from 'node:test';
import assert from 'node:assert/strict';
import {networkLayout} from './network-layout.ts';

test('networkLayout places nodes and clamps to bounds',()=>{
  const ids=['a','b','c'];
  const edges=[{from:'a',to:'b'},{from:'b',to:'c'}];
  const result=networkLayout(ids,edges);
  assert.equal(result.points.length,3);
  assert.ok(result.byId.get('a'));
  assert.ok(result.width>=660);
  assert.ok(result.height>=400);
  for(const p of result.points){
    assert.ok(p.x>=55 && p.x<=result.width-55);
    assert.ok(p.y>=38 && p.y<=result.height-38);
  }
});

test('networkLayout handles single node',()=>{
  const result=networkLayout(['solo'],[]);
  assert.equal(result.points.length,1);
  assert.equal(result.points[0].id,'solo');
});
