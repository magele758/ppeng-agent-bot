import { preferenceStorage } from './user-preference-storage';

export function readChatWidth() {
  const mode = preferenceStorage.getItem('lab.chatWidth') === 'full' ? 'full' : 'center';
  const stored = preferenceStorage.getItem('lab.chatGutter');
  const pixels = Number(stored);
  const gap = stored !== null && Number.isInteger(pixels) && pixels >= 0 && pixels <= 96 ? pixels : 0;
  return { mode, gap };
}

export function applyChatWidth() {
  const { mode, gap } = readChatWidth();
  const root = document.documentElement;
  root.dataset.chatWidth = mode;
  root.style.setProperty('--chat-extra-gap', gap + 'px');
}
