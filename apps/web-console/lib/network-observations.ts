export interface Observation {
  id:string; from:string; to:string; title:string; state:string; at:string;
  report?:string; session?:string; cost?:number;
}
export interface NetworkEdge {from:string;to:string;records:Observation[]}
export function networkEdges(observations:Observation[]):NetworkEdge[] {
  const pairs=new Map<string,NetworkEdge>();
  const seen=new Set<string>();
  for(const row of observations){
    if(seen.has(row.id) || row.from===row.to)continue;
    seen.add(row.id);
    const key=JSON.stringify([row.from,row.to]);
    const edge=pairs.get(key) ?? {from:row.from,to:row.to,records:[]};
    edge.records.push(row);
    pairs.set(key,edge);
  }
  return [...pairs.values()];
}
