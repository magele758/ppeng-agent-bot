export function modelErrorText(message: string, t: (key: 'play.imageUnsupported') => string): string {
  return message.includes('MODEL_IMAGE_UNSUPPORTED:') ? t('play.imageUnsupported') : message;
}
