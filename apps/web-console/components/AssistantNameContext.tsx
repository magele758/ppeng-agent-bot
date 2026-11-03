'use client';
import { createContext, useContext } from 'react';
import { useI18n } from '@/lib/i18n';
import { assistantNameLabel } from '@/lib/assistant-name';

export const AssistantNameContext = createContext<string | null>(null);

export function useAssistantName() {
  const name = useContext(AssistantNameContext);
  const { t } = useI18n();
  return { normal: assistantNameLabel(name, false, t), streaming: assistantNameLabel(name, true, t) };
}
