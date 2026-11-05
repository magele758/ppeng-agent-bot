'use client';
import { useId, useRef, type ReactNode } from 'react';
import './BotRowMenu.css';

export function RowActionMenu({label, children}: {label:string; children:ReactNode}) {
  const id=useId();
  const pop=useRef<HTMLDivElement>(null);
  return <span onClick={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>
    <button type="button" className="btn btn-ghost bot-row-trigger" aria-label={label} popoverTarget={id} onClick={e=>{
      const rect=e.currentTarget.getBoundingClientRect();
      Object.assign(pop.current!.style,{left:Math.max(8,Math.min(rect.right-180,innerWidth-188))+'px',top:Math.max(8,Math.min(rect.bottom+4,innerHeight-240))+'px'});
    }}>⋯</button>
    <div ref={pop} id={id} popover="auto" className="bot-row-pop" onClick={()=>pop.current?.hidePopover()}>{children}</div>
  </span>;
}
