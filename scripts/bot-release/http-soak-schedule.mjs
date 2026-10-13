/** Immutable offered slots. Overloaded workers never move the next ideal deadline. */
export function offeredWriteSlots(warmupSeconds,measurementSeconds,everySeconds,durationSeconds){
 const rows=[];let time=0,index=0,end=(warmupSeconds+measurementSeconds)*1000;
 while(time<end){const elapsed=time/1000-warmupSeconds,burst=elapsed>=everySeconds&&(elapsed%everySeconds)<durationSeconds;rows.push({index:index++,plannedOffset:time,phase:elapsed>=0?'measurement':'warmup',burst,hot:burst&&((index-1)%2===0)});time+=burst?50:500;}
 return rows;
}
// Counts without materializing the 24h list. Smoke fixtures may use the iterable directly.
export function expectedWorkload(configuration){
 const counts={warmup:0,measurement:0,burst:0,hot:0,kinds:{human:0,routine:0,dispatch:0,room:0}};let time=0,index=0,end=(configuration.warmupSeconds+configuration.measurementSeconds)*1000;
 while(time<end){const elapsed=time/1000-configuration.warmupSeconds,burst=elapsed>=configuration.burstEverySeconds&&(elapsed%configuration.burstEverySeconds)<configuration.burstDurationSeconds,phase=elapsed>=0?'measurement':'warmup';counts[phase]++;if(phase==='measurement'){const kind=['human','human','human','human','routine','routine','dispatch','dispatch','room','room'][index%10];counts.kinds[kind]++;if(burst){counts.burst++;if(index%2===0)counts.hot++;}}index++;time+=burst?50:500;}
 return {...counts,readWarmup:configuration.warmupSeconds*40,readMeasurement:configuration.measurementSeconds*40};
}
