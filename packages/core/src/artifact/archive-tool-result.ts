import { createDurableArtifactPort } from './durable-artifact-port.js';
import type { PagedArtifactManifest } from './paged-artifact.js';
import { resolveIngestionSettings, type IngestionSettingsStore } from '../ingestion/settings.js';

export function maybeArchiveToolResult(input: {
  stateDir: string;
  sessionId: string;
  toolName: string;
  content: string;
  settingsStore?: IngestionSettingsStore;
  onCreated?: (manifest: PagedArtifactManifest) => void;
}): string {
  try {
    return createDurableArtifactPort({
      stateDir: input.stateDir,
      settings: () => resolveIngestionSettings(input.settingsStore),
      onRetained: input.onCreated
    }).retain({
      sessionId: input.sessionId,
      source: input.toolName,
      content: input.content,
      mimeType: 'text/plain',
      fileName: `${input.toolName}.txt`
    }).text;
  } catch {
    return input.content;
  }
}
