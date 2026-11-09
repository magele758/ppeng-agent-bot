'use client';
import {useEffect,useRef,type PointerEvent,type ReactNode} from 'react';
import {useI18n} from '@/lib/i18n';
import styles from './bot-network.module.css';

export function NetworkViewport({children,center,ready,onDrag}:{onDrag:()=>void;children:ReactNode;center:number;ready:boolean}){
  const {t}=useI18n();
  const viewport=useRef<HTMLDivElement>(null);
  const centered=useRef(false);
  const gesture=useRef<{id:number;x:number;left:number}|null>(null);
  const dragged=useRef(false);
  useEffect(()=>{
    const el=viewport.current;
    if(!el || !ready || centered.current)return;
    el.scrollLeft=center-el.clientWidth/2;
    centered.current=true;
  },[center,ready]);
  function start(event:PointerEvent<HTMLDivElement>){
    dragged.current=false;
    if(event.button!==0 || event.pointerType==='touch')return;
    gesture.current={id:event.pointerId,x:event.clientX,left:event.currentTarget.scrollLeft};
  }
  function beginDrag(){
    if(!dragged.current)onDrag();
  }
  function move(event:PointerEvent<HTMLDivElement>){
    const g=gesture.current;
    if(g?.id!==event.pointerId || event.buttons!==1)return;
    const dx=event.clientX-g.x;
    if(Math.abs(dx)<5 && !dragged.current)return;
    const el=event.currentTarget;
    beginDrag();
    dragged.current=true;
    el.dataset.dragging='true';
    el.setPointerCapture(event.pointerId);
    el.scrollLeft=g.left-dx;
  }
  function end(event:PointerEvent<HTMLDivElement>){
    gesture.current=null;
    delete event.currentTarget.dataset.dragging;
  }
  return <div ref={viewport} className={styles.viewport} data-testid="network-viewport"
    role="region" tabIndex={0} aria-label={t('tasks.flow.pan')}
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
    onTouchMove={onDrag} onLostPointerCapture={end} onDragStart={e=>e.preventDefault()}
    onClickCapture={e=>{if(dragged.current && e.detail){e.stopPropagation();dragged.current=false;}}}>
    {children}
  </div>;
}
