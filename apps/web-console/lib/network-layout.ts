import type {NetworkEdge} from './network-observations';

function degrees(edges:NetworkEdge[]){
  const counts=new Map<string,number>();
  for(const edge of edges){
    for(const id of [edge.from,edge.to])counts.set(id,(counts.get(id)??0)+1);
  }
  return counts;
}

/** A staggered horizontal field. The most connected participants occupy its centre. */
export function networkLayout(ids:string[],edges:NetworkEdge[]){
  const rows=Math.min(7,Math.max(1,Math.ceil(ids.length/12)));
  const columns=Math.max(1,Math.ceil(ids.length/rows));
  const width=Math.max(1512,columns*94+96);
  const height=448;
  const columnPitch=Math.min(128,(width-168)/columns);
  const rowPitch=Math.min(74,(height-112)/rows);
  const strength=degrees(edges);
  const ordered=[...ids].sort((a,b)=>(strength.get(b)??0)-(strength.get(a)??0));
  // Allocate the odd gaps at the ends, keeping the centre of each band populated.
  const slots=Array.from({length:rows*columns},(_,i)=>{
    const row=i%rows,column=Math.floor(i/rows);
    const x=width/2+(column-(columns-1)/2+(row%2-.5)*.45)*columnPitch+Math.sin(i*2.39)*14;
    const y=height/2+(row-(rows-1)/2)*rowPitch+Math.sin(column*1.8+row)*16;
    return {x,y,distance:Math.hypot((x-width/2)*.75,y-height/2)};
  }).sort((a,b)=>a.distance-b.distance);
  const points=ordered.map((id,i)=>({id,x:slots[i].x,y:slots[i].y,degree:strength.get(id)??0}));
  return {points,byId:new Map(points.map(p=>[p.id,p])),width,height};
}
