import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeTask } from '../agent-eval/quality.mjs';

test('a later correct answer cannot hide a wrong or missing earlier turn [AC:bot-turn-ownership#AC-3]', () => {
  const task = {expected:{exact:'A2',rounds:['A2','B','A2','A2']}};
  const trial = {output:'A2',status:'idle',invariantsOk:true,rounds:['A2','A2','A2','A2']};
  assert.deepEqual(gradeTask(task,trial).failures, ['turn 2 answer']);
  assert.deepEqual(gradeTask(task,{...trial,rounds:[]}).failures, ['turn 1 answer','turn 2 answer','turn 3 answer','turn 4 answer']);
});

test('a correct reply reviewed against a different goal fails its own turn [AC:bot-turn-ownership#AC-2]', () => {
  const task = {turns:['Atlas','Birch'],expected:{exact:'19',rounds:['73','19'],currentGoalOnly:true}};
  const trial = {output:'19',rounds:['73','19'],status:'idle',invariantsOk:true,reviewGoals:[['Atlas'],['Atlas']]};
  assert.deepEqual(gradeTask(task,trial).failures,['turn 2 review ownership']);
  assert.deepEqual(gradeTask(task,{...trial,reviewGoals:[['Atlas'],[]]}).failures,[]);
});
