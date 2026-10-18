import test from 'node:test';
import assert from 'node:assert/strict';
import { modelErrorText } from './model-errors.ts';

test('image incompatibility is localized and unrelated failures keep their detail [AC:bot-chat-image-compatibility#AC-2]', () => {
  assert.equal(modelErrorText('MODEL_IMAGE_UNSUPPORTED: model cannot process images', () => '请选择支持图片的模型'), '请选择支持图片的模型');
  assert.equal(modelErrorText('upstream unavailable', () => 'wrong'), 'upstream unavailable');
});
