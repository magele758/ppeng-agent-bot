export function startBloubClock(draw: (seconds: number) => void, clock: {
  request: (callback: (ms: number) => void) => number;
  cancel: (id: number) => void;
}) {
  let stopped = false;
  let frame = 0;
  const tick = (ms: number) => {
    if (stopped) return;
    draw(ms / 1000);
    if (!stopped) frame = clock.request(tick);
  };
  frame = clock.request(tick);
  return () => { stopped = true; clock.cancel(frame); };
}
