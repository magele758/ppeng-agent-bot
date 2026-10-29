// Preload script - runs in renderer context
// Currently no custom APIs exposed; can be extended later

function markDesktopGlass(): void {
  const root = document.documentElement;
  if (root) {
    root.classList.add('desktop-glass');
    return;
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement?.classList.add('desktop-glass');
  });
}

markDesktopGlass();
console.log('[Preload] Raw Agent Desktop initialized');
