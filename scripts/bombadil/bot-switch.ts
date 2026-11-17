import { always } from '@antithesishq/bombadil';
import { actions, extract, registerCustomAction } from '@antithesishq/bombadil/browser';
import { botNames, historyMarker, sendMarker, transcriptIsIsolated } from './scenario.mjs';

const view = extract(({ document }) => {
  const title = document.querySelector('#playTitle')?.textContent ?? '';
  const feed = document.querySelector('#playMessages')?.textContent ?? '';
  const input = document.querySelector<HTMLTextAreaElement>('#playInput');
  const send = document.querySelector<HTMLButtonElement>('#btnSend');
  const rows = Array.from(document.querySelectorAll('[data-testid="functional-group-ungrouped"] [data-bot-name]'));
  return {
    title, feed, draft: input?.value ?? '', editable: !!input && !input.disabled && !input.readOnly,
    canSend: !!send && !send.disabled,
    choices: rows.filter(row => row.querySelector('button')).map(row => row.getAttribute('data-bot-name'))
  };
});

export const transcriptOwnership = always(() => {
  const { title, feed } = view.current;
  const owner = botNames.find(name => title.includes(name));
  return !owner || transcriptIsIsolated(owner, feed);
});

const selectBot = registerCustomAction('selectBot', async (document, _window, name: string) => {
  const rows = document.querySelectorAll('[data-testid="functional-group-ungrouped"] [data-bot-name]');
  Array.from(rows).find(row => row.getAttribute('data-bot-name') === name)?.querySelector('button')?.click();
});
const draft = registerCustomAction('draftProbe', async (document, _window, text: string) => {
  const input = document.querySelector<HTMLTextAreaElement>('#playInput');
  if (!input) return;
  // React's value tracker must observe the native input event.
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const send = registerCustomAction('sendProbe', async document => {
  document.querySelector<HTMLButtonElement>('#btnSend')?.click();
});

export const explore = actions(() => {
  const state = view.current;
  const selected = botNames.find(name => state.title.includes(name));
  const choices = botNames.filter(name => name !== selected && state.choices.includes(name)).map(name => selectBot(name));
  if (!selected) return choices.length ? choices : ['Wait'];
  if (!state.feed.includes(historyMarker(selected))) return ['Wait'];
  const probe = sendMarker(selected);
  if (state.draft === probe && state.canSend) return [send()];
  const nextDraft = state.editable && !state.draft ? [draft(probe)] : [];
  if (!state.feed.includes(probe) && nextDraft.length) return nextDraft;
  return [...choices, ...nextDraft, 'Reload', 'Wait'];
});
