import type {NetworkEdge} from './network-observations';

interface Point {id:string;x:number;y:number}
function applyForce(a:Point,b:Point,force:number){
  const dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy));
  a.x+=dx/d*force;a.y+=dy/d*force;b.x-=dx/d*force;b.y-=dy/d*force;
}
function clampToBounds(points:Point[],width:number,height:number){
  for(const p of points){p.x=Math.min(width-55,Math.max(55,p.x));p.y=Math.min(height-38,Math.max(38,p.y));}
}
/** Place connected peers near each other while keeping avatar labels apart. */
export function networkLayout(ids:string[],edges:NetworkEdge[]){
  const width=Math.max(660,Math.ceil(Math.sqrt(ids.length))*135);
  const height=Math.max(400,Math.ceil(ids.length/Math.ceil(width/130))*90);
  const points=ids.map((id,i)=>({id,x:width/2+Math.cos(i*2.4)*Math.sqrt(i)*49,y:height/2+Math.sin(i*2.4)*Math.sqrt(i)*38}));
  const byId=new Map(points.map(p=>[p.id,p]));
  for(let pass=0;pass<90;pass++){
    for(const edge of edges){
      const a=byId.get(edge.from)!,b=byId.get(edge.to)!;
      applyForce(a,b,(Math.hypot(a.x-b.x,a.y-b.y)-143)*0.035);
    }
    for(let i=0;i<points.length;i++){
      for(const b of points.slice(i+1)){
        const a=points[i],d=Math.hypot((a.x-b.x)*.78,a.y-b.y);
        if(d<92)applyForce(a,b,(d-92)*.35);
      }
    }
    clampToBounds(points,width,height);
  }
  return {points,byId,width,height};
}
