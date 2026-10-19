export { runIngestion } from './pipeline.js';
export type { IngestionRunResult, RunIngestionInput } from './pipeline.js';
export { normalizeAttachments } from './normalize.js';
export type { AttachmentInput } from './normalize.js';
export { classify, preClassifyKind, isImageFileName, isTextFileName, isWorkspaceFileName } from './classify.js';
export { decode } from './decode.js';
export { decodeTextBytes, looksBinary } from './encoding-policy.js';
export { emit, formatFileContentPrefix, textFileTypeLabel, INLINE_AFFORDANCE } from './emit.js';
export { fetchPayload } from './fetch.js';
export { route } from './route.js';
export { makeFsPorts, defaultDownload, DOWNLOAD_MAX_BYTES } from './ports.js';
export type { IngestionPorts, DownloadResult } from './ports.js';
export { extractOoxmlText, ooxmlKindOf } from './ooxml-text.js';
export type { OoxmlExtraction, OoxmlKind } from './ooxml-text.js';
export {
  INGESTION_SETTINGS_KEY,
  defaultIngestionSettings,
  hasPersistedIngestionSettings,
  normalizeIngestionSettings,
  readIngestionSettings,
  resolveIngestionSettings,
  writeIngestionSettings
} from './settings.js';
export type { IngestionSettings, IngestionSettingsPatch, IngestionSettingsStore } from './settings.js';
export type {
  AttachmentKind,
  AttachmentSource,
  ClassifiedAttachment,
  DecodedAttachment,
  FetchedAttachment,
  IngestContentPart,
  RawAttachment,
  ResolvedAttachment,
  StorageRoute
} from './types.js';
export type { AttachmentStatus, StatusSink } from './status.js';
export { AttachmentIngestService } from './attachment-ingest-service.js';
export type { AttachmentRecord } from './attachment-ingest-service.js';
export {
  applyContextSources,
  contextSourceModelText,
  normalizeContextSources,
  CONTEXT_SOURCE_LIMIT,
  CONTEXT_TEXT_CHAR_LIMIT
} from './context-sources.js';
export type { ContextFileSource, ContextFolderEntry, ContextFolderSource, ContextSource } from './context-sources.js';
