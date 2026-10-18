import type { ModelAdapter, ModelTurnInput } from '../types.js';

/** Only retry explicit image-capability rejections, never generic 400s or size limits. */
function rejectsImages(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\b400\b/.test(error.message) && /at most 0 image\(s\)|(?:image|vision)(?: input)? (?:is |are )?not supported|does not support (?:image|vision)/i.test(error.message);
}

function textOnlyHistory(input: ModelTurnInput): ModelTurnInput | undefined {
  const lastUser = input.messages.findLastIndex(message => message.role === 'user');
  if (lastUser < 0) return undefined;
  // Images supplied or generated during the current request must not be silently lost.
  if (input.messages.slice(lastUser).some(message => message.parts.some(part => part.type === 'image'))) return undefined;
  let removed = false;
  const messages = input.messages.map(message => ({ ...message, parts: message.parts.map(part => {
    if (part.type !== 'image') return part;
    removed = true;
    return { type: 'text' as const, text: `[Historical image ${part.assetId} omitted: current model does not support image input.]` };
  }) }));
  return removed ? { ...input, messages } : undefined;
}

function compatibleRetry(error: unknown, input: ModelTurnInput, emitted: boolean): ModelTurnInput {
  if (emitted || input.signal?.aborted || !rejectsImages(error)) throw error;
  const retry = textOnlyHistory(input);
  if (retry) return retry;
  throw Object.assign(new Error('MODEL_IMAGE_UNSUPPORTED: The selected model cannot process images. Select an image-capable model or send text only.', { cause: error }), { status: 400 });
}

export function withImageCompatibility(adapter: ModelAdapter): ModelAdapter {
  const wrapped: ModelAdapter = Object.create(adapter);
  wrapped.runTurn = async input => {
    try { return await adapter.runTurn(input); }
    catch (error) { return adapter.runTurn(compatibleRetry(error, input, false)); }
  };
  if (adapter.runTurnStream) {
    const stream = adapter.runTurnStream.bind(adapter);
    wrapped.runTurnStream = async (input, emit) => {
      let emitted = false;
      try { return await stream(input, chunk => { emitted = true; emit(chunk); }); }
      catch (error) { return stream(compatibleRetry(error, input, emitted), emit); }
    };
  }
  return wrapped;
}
