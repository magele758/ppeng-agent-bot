export function markDesktopGlass(doc: Document = document): void {
  const root = doc.documentElement;
  if (root) {
    root.classList.add('desktop-glass');
    return;
  }
  doc.addEventListener('DOMContentLoaded', () => {
    doc.documentElement?.classList.add('desktop-glass');
  });
}

if (typeof document !== 'undefined') {
  markDesktopGlass();
}
console.log('[Preload] Raw Agent Desktop initialized');
