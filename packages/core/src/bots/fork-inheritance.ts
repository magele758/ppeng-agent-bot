/**
 * Shared spawn binding for concurrent, delegated, and steering children.
 * Copies retrieval scope only. The opening message stays the task text plus
 * image and attachment references; skill bodies, file bodies, and the parent
 * transcript are not pasted into that text.
 */

import { createId } from '../id.js';
import type { ImageAssetRecord, ImagePart, MessagePart, SessionMessage, TextPart } from '../types.js';
import { requestedSkillNames, skillScopeFromMetadata } from '../runtime/run-profile.js';
import { inheritWorkspaceBinding } from '../workspace/index.js';

const FENCE_BLOCK = /«external [\s\S]*?«end external»/g;

export interface ImageBindStore {
  getImageAsset(id: string): ImageAssetRecord | undefined;
  createImageAsset(asset: ImageAssetRecord): ImageAssetRecord;
}

/** Task text with attachment fences removed so file bodies stay out of the prompt. */
export function visibleTaskText(text: string): string {
  return text.replace(FENCE_BLOCK, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Workspace binding, explicit skillScope, requested skill names, and an explicit
 * optional-tool-group selection. Missing keys stay missing so a child does not
 * invent a narrower or wider default than the parent session.
 */
export function inheritForkRetrievalMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...inheritWorkspaceBinding(metadata) };
  if (!metadata) return patch;
  if (metadata.skillScope != null || metadata.skill_scope != null) {
    patch.skillScope = skillScopeFromMetadata(metadata);
  }
  const requested = requestedSkillNames(metadata);
  if (requested.length > 0) patch.requestedSkills = requested;
  if (Object.prototype.hasOwnProperty.call(metadata, 'enabledOptionalToolGroups')) {
    const raw = metadata.enabledOptionalToolGroups;
    patch.enabledOptionalToolGroups = Array.isArray(raw)
      ? raw
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
      : [];
  }
  return patch;
}

function copySources(parts: readonly MessagePart[] | undefined): TextPart['contextSources'] {
  const sources: NonNullable<TextPart['contextSources']> = [];
  for (const part of parts ?? []) {
    if (part.type !== 'text' || !part.contextSources?.length) continue;
    for (const source of part.contextSources) {
      if (sources.length >= 20) return sources;
      if (source.kind === 'file') {
        sources.push({ kind: 'file', name: source.name, text: source.text });
      } else {
        sources.push({
          kind: 'folder',
          name: source.name,
          entries: source.entries.map((entry) => ({ path: entry.path, text: entry.text }))
        });
      }
    }
  }
  return sources;
}

function copyImagePart(part: ImagePart): ImagePart {
  return {
    type: 'image',
    assetId: part.assetId,
    mimeType: part.mimeType,
    ...(part.alt ? { alt: part.alt } : {}),
    ...(part.sourceUrl ? { sourceUrl: part.sourceUrl } : {}),
    ...(part.retentionTier ? { retentionTier: part.retentionTier } : {})
  };
}

/** Task text, attachment references, and image parts. Fence text is not copied. */
export function forkOpeningParts(taskText: string, triggerParts?: readonly MessagePart[]): MessagePart[] {
  const text = visibleTaskText(taskText);
  const sources = copySources(triggerParts) ?? [];
  const images = (triggerParts ?? [])
    .filter((part): part is ImagePart => part.type === 'image')
    .map(copyImagePart);
  const parts: MessagePart[] = [];
  if (text || sources.length > 0) {
    const carrier: TextPart = { type: 'text', text: text || '(attachment)' };
    if (sources.length > 0) carrier.contextSources = sources;
    parts.push(carrier);
  }
  parts.push(...images);
  if (parts.length === 0) parts.push({ type: 'text', text });
  return parts;
}

export function latestUserTriggerParts(messages: readonly SessionMessage[]): MessagePart[] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message.parts;
  }
  return undefined;
}

/**
 * Re-home parent-owned image rows onto the child so existing session checks can
 * read them. Assets from any other session are dropped.
 */
export function bindInheritedImages(
  store: ImageBindStore,
  parentSessionId: string,
  childSessionId: string,
  parts: readonly MessagePart[]
): MessagePart[] {
  const bound: MessagePart[] = [];
  for (const part of parts) {
    if (part.type !== 'image') {
      bound.push(part);
      continue;
    }
    const asset = store.getImageAsset(part.assetId);
    if (!asset) {
      bound.push(part);
      continue;
    }
    if (asset.sessionId !== parentSessionId) continue;
    const id = createId('img');
    store.createImageAsset({
      ...asset,
      id,
      sessionId: childSessionId,
      derivedFromIds: [...(asset.derivedFromIds ?? []), asset.id]
    });
    bound.push({ ...part, assetId: id });
  }
  return bound;
}

export function forkOpeningMessage(input: {
  store: ImageBindStore;
  parentSessionId: string;
  childSessionId: string;
  taskText: string;
  triggerParts?: readonly MessagePart[];
}): MessagePart[] {
  const parts = bindInheritedImages(
    input.store,
    input.parentSessionId,
    input.childSessionId,
    forkOpeningParts(input.taskText, input.triggerParts)
  );
  return parts.length > 0 ? parts : [{ type: 'text', text: visibleTaskText(input.taskText) }];
}
