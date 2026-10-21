/** Batch only the load driver's observations, never the daemon's durable writes. */
export function createLedgerBatch(db,now){
 let active=false,lastCommit=0;
 return {
  start(){if(active)return;db.exec('BEGIN');active=true;lastCommit=now();},
  flush(){if(!active||now()-lastCommit<100)return;db.exec('COMMIT');active=false;db.exec('BEGIN');active=true;lastCommit=now();},
  finish(){if(!active)return;db.exec('COMMIT');active=false;}
 };
}
