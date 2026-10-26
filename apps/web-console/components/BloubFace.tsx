'use client';

import { useEffect, useRef } from 'react';
import { botFaceClassName, type LivingFaceMood } from '@/lib/bot-face';
import { softBotFaceFromSeed, softBotFaceSeed, SOFT_BOT_SWATCH, eyeInkForSoftColor, type SoftBotSilhouette, type SoftBotColor, type SoftBotExpression } from '@/lib/soft-bot-face';
import { startBloubClock } from '@/lib/bloub-motion';
import type { ShapeId, ExpressionId } from '@norbert_bodziony/bloub';

const shapes: Record<SoftBotSilhouette, ShapeId> = { pebble: 'cercle', squish: 'squircle', capsule: 'capsule', cloud: 'nuage', drop: 'goutte', bean: 'galet', nub: 'triangle', pillow: 'hexagone' };
const expressions: Record<SoftBotExpression, ExpressionId> = { neutral: 'neutre', happy: 'heureux', curious: 'curieux', sleepy: 'somnolent', wink: 'heureux', content: 'fier', wide: 'surpris', shy: 'timide' };

export function BloubFace({ name, seed, silhouette, color, expression, mood = 'idle', label, testId, size = 'sm', className }: {
  name?: string | null; id?: string | null; seed?: string;
  silhouette?: SoftBotSilhouette | null; color?: SoftBotColor | null; expression?: SoftBotExpression | null;
  mood?: LivingFaceMood; label?: string; testId?: string; size?: 'sm' | 'md' | 'lg'; className?: string;
}) {
  const root = useRef<SVGSVGElement>(null);
  const face = softBotFaceFromSeed(seed ?? softBotFaceSeed({ name }), { silhouette, color, expression });
  const working = mood !== 'idle';
  useEffect(() => {
    const svg = root.current;
    if (!svg) return;
    let disposed = false;
    let stop = () => {};
    let observer: IntersectionObserver | undefined;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let sync = () => {};
    const changed = () => sync();
    media.addEventListener('change', changed);
    document.addEventListener('visibilitychange', changed);
    svg.addEventListener('pointerenter', changed);
    svg.addEventListener('pointerleave', changed);
    svg.addEventListener('focusin', changed);
    svg.addEventListener('focusout', changed);
    void import('@norbert_bodziony/bloub').then(({ BotEngine, SHAPE_BY_ID, EXPRESSION_BY_ID, RAYON, DEMI_VIEWBOX }) => {
      if (disposed) return;
      svg.setAttribute('viewBox', `${-DEMI_VIEWBOX} ${-DEMI_VIEWBOX} ${DEMI_VIEWBOX * 2} ${DEMI_VIEWBOX * 2}`);
      const state = !working && face.expression === 'wink' ? 'wink' : 'idle';
      const engine = new BotEngine(RAYON, state, SHAPE_BY_ID.get(shapes[face.silhouette])!.radii, EXPRESSION_BY_ID.get(working ? 'attentif' : expressions[face.expression]));
      const body = svg.querySelector('[data-bloub-body]')!;
      const eyes = svg.querySelectorAll('[data-bloub-eye]');
      const orbit = svg.querySelector('[data-bloub-orbit]')!;
      let visible = true;
      const draw = (time: number) => {
        const frame = engine.sample(time);
        body.setAttribute('d', frame.bodyPath);
        body.setAttribute('opacity', String(frame.bodyAlpha));
        body.setAttribute('transform', working ? `scale(${1 + Math.sin(time * 2.4) * 0.025})` : '');
        frame.eyes.forEach((eye, i) => {
          eyes[i]?.setAttribute('d', eye.d);
          eyes[i]?.setAttribute('transform', eye.matrix);
          eyes[i]?.setAttribute('opacity', String(eye.alpha));
        });
        orbit.setAttribute('transform', `rotate(${time * 65})`);
      };
      sync = () => {
        if (disposed) return;
        stop();
        const animate = !media.matches && !document.hidden && visible && (working || svg.matches(':hover, :focus-within'));
        svg.setAttribute('data-bloub-animated', String(animate));
        draw(animate ? performance.now() / 1000 : 2);
        if (animate) stop = startBloubClock(draw, { request: callback => window.requestAnimationFrame(callback), cancel: frame => window.cancelAnimationFrame(frame) });
      };
      observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; sync(); });
      observer.observe(svg);
      svg.setAttribute('data-bloub-ready', 'true');
      sync();
    }).catch(() => { if (!disposed) svg.setAttribute('data-bloub-ready', 'error'); });
    return () => {
      disposed = true; stop(); observer?.disconnect();
      media.removeEventListener('change', changed);
      document.removeEventListener('visibilitychange', changed);
      svg.removeEventListener('pointerenter', changed); svg.removeEventListener('pointerleave', changed);
      svg.removeEventListener('focusin', changed); svg.removeEventListener('focusout', changed);
    };
  }, [face.silhouette, face.expression, working]);
  return <svg ref={root} viewBox="-158 -158 316 316" className={botFaceClassName({ size, className })}
    data-testid={testId} data-bloub-face={shapes[face.silhouette]} data-bloub-color={face.color} data-bloub-expression={face.expression}
    data-face-mood={mood} data-face-working={working} role={label ? 'img' : 'presentation'} aria-label={label} aria-hidden={label ? undefined : true}>
    <g data-bloub-orbit="" fill="none" stroke={SOFT_BOT_SWATCH[face.color]} strokeWidth="5" opacity={working ? 0.65 : 0}>
      <circle r="132" strokeDasharray="90 45 50 645" />
    </g>
    <path data-bloub-body="" d="M -100 0 a 100 100 0 1 0 200 0 a 100 100 0 1 0 -200 0" fill={SOFT_BOT_SWATCH[face.color]} />
    {[0, 1].map(i => <path key={i} data-bloub-eye="" d={`M ${i === 0 ? -36 : 22} -15 a 8 8 0 0 1 16 0 v 24 a 8 8 0 0 1 -16 0 z`} fill={eyeInkForSoftColor(face.color)} />)}
  </svg>;
}
