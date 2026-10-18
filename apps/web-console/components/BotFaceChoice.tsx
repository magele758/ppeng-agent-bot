'use client';

import { useId, type ReactNode } from 'react';
import {
  BOT_FACE_PICKER_COLORS,
  BOT_FACE_PICKER_SHAPES,
  BOT_FACE_SWATCH,
  previewFaceChoice,
  resolveBotFaceAppearance,
  type BotFaceColor,
  type BotFaceShape
} from '@/lib/bot-face';
import { useI18n } from '@/lib/i18n';
import { BotFace } from './BotFace';

export function BotFaceChoice({
  name,
  shape,
  color,
  onShape,
  onColor,
  disabled,
  showLabels = false,
  children
}: {
  name: string;
  shape: BotFaceShape | null;
  color: BotFaceColor | null;
  onShape: (shape: BotFaceShape) => void;
  onColor: (color: BotFaceColor) => void;
  disabled?: boolean;
  showLabels?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const shapeLabelId = useId();
  const colorLabelId = useId();
  const shown = resolveBotFaceAppearance({ name, savedShape: shape, savedColor: color });
  const previewColor = shown.color ?? 'red';
  const previewFace = previewFaceChoice(shape, color, shown);
  return (
    <fieldset className="bot-face-choice" disabled={disabled}>
      <div className="bot-face-choice__preview">
        <BotFace
          name={name}
          {...previewFace}
          size="lg"
          testId="bot-face-choice-preview"
          label={t('agents.bots.faceLabel', { name: name.trim() || t('agents.bots.faceEmpty') })}
        />
      </div>
      {children}
      <div className="bot-face-choice__group">
        <span className={showLabels ? 'ag-field__label' : 'sr-only'} id={shapeLabelId}>
          {t('agents.bots.faceShapeLabel')}
        </span>
        <div className="bot-face-choice__shapes" role="group" aria-labelledby={shapeLabelId}>
          {BOT_FACE_PICKER_SHAPES.map((id) => (
            <button
              key={id}
              type="button"
              className="bot-face-choice__shape"
              aria-pressed={shown.shape === id}
              aria-label={t(`agents.bots.faceShape.${id}`)}
              onClick={() => onShape(id)}
            >
              <BotFace name="" shape={id} color={previewColor} />
            </button>
          ))}
        </div>
      </div>
      <div className="bot-face-choice__group">
        <span className={showLabels ? 'ag-field__label' : 'sr-only'} id={colorLabelId}>
          {t('agents.bots.faceColorLabel')}
        </span>
        <div className="bot-face-choice__colors" role="group" aria-labelledby={colorLabelId}>
          {BOT_FACE_PICKER_COLORS.map((id) => (
            <button
              key={id}
              type="button"
              className="bot-face-choice__color"
              style={{ background: BOT_FACE_SWATCH[id] }}
              aria-pressed={shown.color === id}
              aria-label={t(`agents.bots.faceColor.${id}`)}
              onClick={() => onColor(id)}
            />
          ))}
        </div>
      </div>
      <p className="ag-field__hint">{t('agents.bots.faceHint')}</p>
    </fieldset>
  );
}
