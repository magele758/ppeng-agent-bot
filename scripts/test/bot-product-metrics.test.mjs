import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers/bot-http-fixture.mjs';

test('delivery review and metrics are scoped to the authenticated owner [AC:bot-product-p2#AC-8]', async () => {
  const daemon = await boot();
  try {
    const bot = (await daemon.call('alice','POST','/api/bots',{name:'Measured worker'})).body.bot;
    const dispatched = await daemon.call('alice','POST','/api/bot-work/tasks',{targetBotId:bot.id,input:'Reply ready'});
    assert.equal(dispatched.status,202);
    const id=dispatched.body.task.id;
    let task;
    for(let i=0;i<100;i++){
      task=(await daemon.call('alice','GET',`/api/bot-work/tasks/${id}`)).body.task;
      if(task.delivery)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(task.delivery);
    const review=await daemon.call('alice','POST',`/api/bot-work/tasks/${id}/review`,{attempt:task.attempt,accepted:true});
    assert.equal(review.status,200);
    assert.notEqual((await daemon.call('bob','POST',`/api/bot-work/tasks/${id}/review`,{attempt:task.attempt,accepted:false})).status,200);
    const path='/api/bot-work/metrics?from=2000-01-01T00%3A00%3A00Z&to=2100-01-01T00%3A00%3A00Z';
    const alice=await daemon.call('alice','GET',path),bob=await daemon.call('bob','GET',path);
    assert.equal(alice.status,200);assert.equal(bob.status,200);
    assert.equal(alice.body.metrics.accepted,1);assert.equal(bob.body.metrics.tasks,0);
  } finally {await daemon.close();}
});
