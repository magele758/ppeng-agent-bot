/** One lane executes both variants sequentially; each repetition waits for all lanes. */
export async function runPairedTasks(suite,{trials,concurrency=1,baselineOnly=false},run) {
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('concurrency must be 1..4');
 for(let trial=0;trial<trials;trial++) {
  let next=0;
  const lanes=Array.from({length:Math.min(concurrency,suite.length)},async()=>{
   while(next<suite.length){
    const index=next++,labels=baselineOnly?['baseline']:(trial+index)%2?['candidate','baseline']:['baseline','candidate'];
    for(const label of labels)await run(suite[index],trial,label);
   }
  });
  // Do not clean up other active workers if a lane fails.
  const results=await Promise.allSettled(lanes);
  const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
 }
}
