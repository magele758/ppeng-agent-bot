'use client';

import { useId, type ReactNode } from 'react';
import {
  BOT_FACE_PICKER_COLORS,
  BOT_FACE_PICKER_SHAPES,
  BOT_FACE_SWATCH,
  previewFaceChoice,
  readBotFaceStyle,
  resolveBotFaceAppearance,
  type BotFaceColor,
  type BotFaceShape,
  type BotFaceStyle
} from '@/lib/bot-face';
import {
  SOFT_BOT_COLORS,
  SOFT_BOT_EXPRESSIONS,
  SOFT_BOT_SILHOUETTES,
  SOFT_BOT_SWATCH,
  isSoftBotColor,
  isSoftBotExpression,
  isSoftBotSilhouette,
  softBotFaceFromSeed,
  softBotFaceSeed,
  type SoftBotColor,
  type SoftBotExpression,
  type SoftBotSilhouette
} from '@/lib/soft-bot-face';
import { useI18n } from '@/lib/i18n';
import { BotFace } from './BotFace';
import { SoftBotFace } from './SoftBotFace';

export function BotFaceChoice({
  name,
  botId,
  shape,
  color,
  style,
  softSilhouette,
  softColor,
  softExpression,
  onShape,
  onColor,
  onStyle,
  onSoftSilhouette,
  onSoftColor,
  onSoftExpression,
  disabled,
  showLabels = false,
  children
}: {
  name: string;
  botId?: string | null;
  shape: BotFaceShape | null;
  color: BotFaceColor | null;
  style?: BotFaceStyle | null;
  softSilhouette?: SoftBotSilhouette | null;
  softColor?: SoftBotColor | null;
  softExpression?: SoftBotExpression | null;
  onShape: (shape: BotFaceShape) => void;
  onColor: (color: BotFaceColor) => void;
  onStyle?: (style: BotFaceStyle) => void;
  onSoftSilhouette?: (silhouette: SoftBotSilhouette) => void;
  onSoftColor?: (color: SoftBotColor) => void;
  onSoftExpression?: (expression: SoftBotExpression) => void;
  disabled?: boolean;
  showLabels?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const styleLabelId = useId();
  const shapeLabelId = useId();
  const colorLabelId = useId();
  const expressionLabelId = useId();
  const faceStyle = readBotFaceStyle(style) ?? 'classic';
  const shown = resolveBotFaceAppearance({ name, savedShape: shape, savedColor: color });
  const previewColor = shown.color ?? 'red';
  const previewFace = previewFaceChoice(shape, color, shown);
  const seed = softBotFaceSeed({ id: botId, name });
  const soft = softBotFaceFromSeed(seed, {
    silhouette: softSilhouette,
    color: softColor,
    expression: softExpression
  });
  const softShape = isSoftBotSilhouette(softSilhouette) ? softSilhouette : soft.silhouette;
  const softSwatch = isSoftBotColor(softColor) ? softColor : soft.color;
  const softLook = isSoftBotExpression(softExpression) ? softExpression : soft.expression;
  return (
    <fieldset className="bot-face-choice" disabled={disabled} data-face-style={faceStyle}>
      <div className="bot-face-choice__styles" role="group" aria-labelledby={styleLabelId}>
        <span className="sr-only" id={styleLabelId}>
          {t('agents.bots.faceStyleLabel')}
        </span>
        {(['classic', 'soft'] as const).map((id) => (
          <button
            key={id}
            type="button"
            className="bot-face-choice__style"
            data-testid={`bot-face-style-${id}`}
            aria-pressed={faceStyle === id}
            onClick={() => onStyle?.(id)}
          >
            {t(`agents.bots.faceStyle.${id}`)}
          </button>
        ))}
      </div>
      <div className="bot-face-choice__preview">
        {faceStyle === 'soft' ? (
          <SoftBotFace
            seed={seed}
            silhouette={softSilhouette}
            color={softColor}
            expression={softExpression}
            size="lg"
            className="bot-face--soft-preview"
            testId="bot-face-choice-preview"
            label={t('agents.bots.faceLabel', { name: name.trim() || t('agents.bots.faceEmpty') })}
          />
        ) : (
          <BotFace
            name={name}
            {...previewFace}
            faceStyle="classic"
            size="lg"
            testId="bot-face-choice-preview"
            label={t('agents.bots.faceLabel', { name: name.trim() || t('agents.bots.faceEmpty') })}
          />
        )}
      </div>
      {children}
      {faceStyle === 'soft' ? (
        <>
          <div className="bot-face-choice__group">
            <span className={showLabels ? 'ag-field__label' : 'sr-only'} id={shapeLabelId}>
              {t('agents.bots.faceShapeLabel')}
            </span>
            <div className="bot-face-choice__shapes" role="group" aria-labelledby={shapeLabelId}>
              {SOFT_BOT_SILHOUETTES.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="bot-face-choice__shape"
                  aria-pressed={softShape === id}
                  aria-label={t(`agents.bots.softShape.${id}`)}
                  onClick={() => onSoftSilhouette?.(id)}
                >
                  <SoftBotFace seed={seed} silhouette={id} color={softSwatch} expression={softLook} />
                </button>
              ))}
            </div>
          </div>
          <div className="bot-face-choice__group">
            <span className={showLabels ? 'ag-field__label' : 'sr-only'} id={colorLabelId}>
              {t('agents.bots.faceColorLabel')}
            </span>
            <div className="bot-face-choice__colors" role="group" aria-labelledby={colorLabelId}>
              {SOFT_BOT_COLORS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="bot-face-choice__color"
                  style={{ background: SOFT_BOT_SWATCH[id] }}
                  aria-pressed={softSwatch === id}
                  aria-label={t(`agents.bots.softColor.${id}`)}
                  onClick={() => onSoftColor?.(id)}
                />
              ))}
            </div>
          </div>
          <div className="bot-face-choice__group">
            <span className={showLabels ? 'ag-field__label' : 'sr-only'} id={expressionLabelId}>
              {t('agents.bots.softExpressionLabel')}
            </span>
            <div className="bot-face-choice__expressions" role="group" aria-labelledby={expressionLabelId}>
              {SOFT_BOT_EXPRESSIONS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="bot-face-choice__expression"
                  aria-pressed={softLook === id}
                  onClick={() => onSoftExpression?.(id)}
                >
                  {t(`agents.bots.softExpression.${id}`)}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
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
                  <BotFace name="" shape={id} color={previewColor} faceStyle="classic" />
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
        </>
      )}
      <p className="ag-field__hint">{t('agents.bots.faceHint')}</p>
    </fieldset>
  );
}
