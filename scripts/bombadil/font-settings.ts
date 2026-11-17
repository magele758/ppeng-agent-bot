import { always } from '@antithesishq/bombadil';
import { actions, extract, registerCustomAction } from '@antithesishq/bombadil/browser';
import { installFontMeter } from './font-meter.mjs';

const page = extract(({ document, window }) => {
  const select = document.querySelector<HTMLSelectElement>('#font-size-choice');
  return {
    meter: (window as any).__fontComparison ?? null,
    size: select?.value ?? '', options: Array.from(select?.options ?? [], option => option.value),
    width: window.innerWidth, lang: document.documentElement.lang,
    canary: new URL(window.location.href).searchParams.has('fontCanary'),
    injected: !!document.getElementById('font-comparison-canary')
  };
});
const install = registerCustomAction('observeFont', async () => installFontMeter());
const corrupt = registerCustomAction('breakPreview', async document => {
  const style = document.createElement('style');
  style.id = 'font-comparison-canary';
  style.textContent = '#card-font-size .font-size-preview { font-size: 1px !important }';
  document.head.append(style);
});
const choose = registerCustomAction('chooseSize', async (document, _window, value: string) => {
  const select = document.querySelector<HTMLSelectElement>('#font-size-choice');
  if (!select) return;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
});
const language = registerCustomAction('toggleLanguage', async document => {
  document.querySelector<HTMLButtonElement>('[data-testid="language-toggle"] button[aria-pressed="false"]')?.click();
});

export const fontPreviewMatches = always(() => !page.current.meter?.violation);
export const exploreFonts = actions(() => {
  const state = page.current;
  if (!state.meter) return [install()];
  if (!state.size) return ['Wait'];
  if (state.canary) return state.injected ? ['Wait'] : [corrupt()];
  return [
    ...state.options.filter(value => value !== state.size).map(value => choose(value)),
    language(), 'Reload', 'Wait',
    { SetViewport: { width: state.width === 640 ? 1280 : 640, height: 900 } }
  ];
});
