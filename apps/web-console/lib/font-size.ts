export const FONT_SIZES = [13, 14, 15, 16, 18] as const;
export const DEFAULT_FONT_SIZE = 14;
export const FONT_SIZE_STORAGE_KEY = 'lab.fontSize';

export function normalizeFontSize(value: unknown): number {
  const size = Number(value);
  return FONT_SIZES.some(option => option === size) ? size : DEFAULT_FONT_SIZE;
}

// Runs in the document head, before the first visible content.
export const FONT_SIZE_BOOTSTRAP = `(()=>{let size=${DEFAULT_FONT_SIZE};try{const saved=Number(localStorage.getItem('${FONT_SIZE_STORAGE_KEY}'));if(${JSON.stringify(FONT_SIZES)}.includes(saved))size=saved;}catch{}document.documentElement.setAttribute('data-font-size',String(size));})();`;

export function applyFontSize(size: number): boolean {
  const value = String(normalizeFontSize(size));
  document.documentElement.setAttribute('data-font-size', value);
  try {
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}
