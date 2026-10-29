import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  artifactIndexFromManifest,
  createDurableArtifactPort,
  NotFoundError,
  readIngestionSettings,
  type ArtifactLocateResult,
  type RawAgentRuntime
} from '@ppeng/agent-core';

type IndexedArtifact = NonNullable<ReturnType<RawAgentRuntime['getArtifactIndex']>>;

/** The daemon's DurableArtifactPort: thresholds from the saved ingestion setting, index on retain. */
export function createDaemonArtifactPort(runtime: RawAgentRuntime) {
  return createDurableArtifactPort({
    stateDir: runtime.stateDir,
    settings: () => readIngestionSettings(runtime.store),
    onRetained(manifest) {
      runtime.store.createArtifactIndex(artifactIndexFromManifest(manifest));
    }
  });
}

function downloadTarget(
  located: ArtifactLocateResult,
  row: IndexedArtifact,
  stateDir: string
): { abs: string; mimeType: string; fileName: string } | undefined {
  if (located.found) {
    return {
      abs: located.absPath,
      mimeType: located.manifest.mimeType || 'application/octet-stream',
      fileName: basename(located.manifest.fileName || located.manifest.storageRelPath)
    };
  }
  switch (located.reason) {
    case 'missing':
      return {
        abs: join(stateDir, row.localRelPath),
        mimeType: row.mimeType || 'application/octet-stream',
        fileName: basename(row.fileName || row.localRelPath)
      };
    case 'forbidden':
      return undefined;
    default: {
      const neverReason: never = located.reason;
      return neverReason;
    }
  }
}

/** Bytes for the existing artifact download. Wrong-session manifests are refused. */
export function openArtifactForDownload(runtime: RawAgentRuntime, id: string): {
  mimeType: string;
  fileName: string;
  bytes: Buffer;
} {
  const row = runtime.getArtifactIndex(id);
  if (!row) throw new NotFoundError('Artifact', id);
  const target = downloadTarget(
    createDaemonArtifactPort(runtime).locate({ sessionId: row.sessionId, handle: id }),
    row,
    runtime.stateDir
  );
  if (!target || !existsSync(target.abs)) throw new NotFoundError(target ? 'Artifact file' : 'Artifact', id);
  return { mimeType: target.mimeType, fileName: target.fileName, bytes: readFileSync(target.abs) };
}
