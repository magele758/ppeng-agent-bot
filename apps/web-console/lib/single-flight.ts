/** Concurrent callers share one request; failures release the lock too. */
export function singleFlight<T>(work: () => Promise<T>): () => Promise<T> {
 let pending: Promise<T> | undefined;
 return () => {
  if (pending) return pending;
  pending = Promise.resolve().then(work).finally(() => { pending = undefined; });
  return pending;
 };
}
