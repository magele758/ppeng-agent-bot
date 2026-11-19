/**
 * Calls `refresh` when the user comes back to the page: the window regains focus or the
 * tab turns visible. Values other tabs or people may have changed meanwhile are read
 * again then, instead of polling. Returns the unsubscribe.
 */
export function onPageReturn(
  win: EventTarget,
  doc: EventTarget & { visibilityState?: string },
  refresh: () => void
): () => void {
  const onFocus = () => refresh();
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') refresh();
  };
  win.addEventListener('focus', onFocus);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('focus', onFocus);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
