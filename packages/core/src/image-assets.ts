import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageAssetRecord, ImageRetentionTier, SessionRecord } from './types.js';
import { createId, nowIso } from './id.js';
import type { SqliteStateStore } from './storage.js';
import { envInt } from './env.js';
import { fetchPinnedPublic, webFetchAllowsPrivate, type PublicFetchDeps } from './net/public-fetch.js';

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function isAllowedImageMime(mime: string): boolean {
  const head = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  return ALLOWED_IMAGE_MIMES.has(head);
}

export function extensionForMime(mime: string): string {
  const base = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (base === 'image/png') return 'png';
  if (base === 'image/jpeg') return 'jpg';
  if (base === 'image/webp') return 'webp';
  if (base === 'image/gif') return 'gif';
  return 'bin';
}

export interface IngestImageInput {
  sessionId: string;
  buffer: Buffer;
  mimeType: string;
  sourceType: 'upload' | 'url' | 'derived';
  sourceUrl?: string;
  derivedFromIds?: string[];
  kind?: 'original' | 'contact_sheet';
  retentionTier?: ImageRetentionTier;
}

/** Persist bytes under stateDir and insert image_assets row. */
export async function ingestImageAsset(
  store: SqliteStateStore,
  stateDir: string,
  input: IngestImageInput
): Promise<ImageAssetRecord> {
  const mime = input.mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!isAllowedImageMime(mime)) {
    throw new Error(`Unsupported image mime: ${input.mimeType}`);
  }
  const maxBytes = envInt(process.env, 'RAW_AGENT_IMAGE_MAX_BYTES', 12_000_000);
  if (input.buffer.length > maxBytes) {
    throw new Error(`Image exceeds limit of ${maxBytes} bytes`);
  }

  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const existing = store
    .listImageAssetsForSession(input.sessionId)
    .find((a) => a.sha256 === sha256 && a.kind === (input.kind ?? 'original'));
  if (existing && (input.kind ?? 'original') === 'original') {
    await touchImageAccess(store, existing.id);
    return existing;
  }

  const id = createId('img');
  const ext = extensionForMime(mime);
  const rel = join('images', input.sessionId, `${id}.${ext}`);
  const abs = join(stateDir, rel);
  await mkdir(join(stateDir, 'images', input.sessionId), { recursive: true });
  await writeFile(abs, input.buffer);

  const now = nowIso();
  const asset: ImageAssetRecord = {
    id,
    sessionId: input.sessionId,
    sha256,
    mimeType: mime,
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl,
    localRelPath: rel.split(/[/\\]/).join('/'),
    sizeBytes: input.buffer.length,
    derivedFromIds: input.derivedFromIds ?? [],
    retentionTier: input.retentionTier ?? 'hot',
    kind: input.kind ?? 'original',
    lastAccessAt: now,
    createdAt: now
  };
  return store.createImageAsset(asset);
}

export async function readImageBuffer(store: SqliteStateStore, stateDir: string, assetId: string): Promise<Buffer> {
  const asset = store.getImageAsset(assetId);
  if (!asset) {
    throw new Error(`Image asset ${assetId} not found`);
  }
  const abs = join(stateDir, asset.localRelPath);
  return readFile(abs);
}

export async function imageBufferToDataUrl(store: SqliteStateStore, stateDir: string, assetId: string): Promise<string> {
  const asset = store.getImageAsset(assetId);
  if (!asset) {
    return '';
  }
  const buf = await readImageBuffer(store, stateDir, assetId);
  const b64 = buf.toString('base64');
  return `data:${asset.mimeType};base64,${b64}`;
}

export async function touchImageAccess(store: SqliteStateStore, assetId: string): Promise<void> {
  const a = store.getImageAsset(assetId);
  if (!a) return;
  store.updateImageAsset(assetId, { lastAccessAt: nowIso() });
}

export async function fetchImageFromUrl(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
  deps?: PublicFetchDeps
): Promise<{ buffer: Buffer; mimeType: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchPinnedPublic(url, {
      signal: ctrl.signal,
      allowPrivateHosts: deps?.allowPrivateHosts ?? webFetchAllowsPrivate(),
      resolveHost: deps?.resolveHost,
      request: deps?.request,
      maxRedirects: deps?.maxRedirects
    });
    if (!res.ok) {
      throw new Error(`Fetch image failed ${res.status}`);
    }
    const ct = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`Downloaded image exceeds ${maxBytes} bytes`);
    }
    let mime = ct;
    if (!isAllowedImageMime(mime)) {
      if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
      else if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
      else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
      else if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42) mime = 'image/webp';
    }
    if (!isAllowedImageMime(mime)) {
      throw new Error(`URL did not return an allowed image type (got ${ct})`);
    }
    return { buffer: buf, mimeType: mime };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Lazy-load sharp. The dependency is moved to optionalDependencies so a fresh
 * `npm install` won't fail on platforms where the prebuilt binaries are
 * unavailable; we degrade gracefully (skip contact-sheet generation) instead.
 *
 * Cached after the first successful load to avoid repeating the dynamic import
 * cost; cached `null` after first failure so we don't keep re-trying.
 */
let cachedSharp: typeof import('sharp') | null | undefined;
async function loadSharp(): Promise<typeof import('sharp') | null> {
  if (cachedSharp !== undefined) return cachedSharp;
  try {
    cachedSharp = (await import('sharp')).default as unknown as typeof import('sharp');
  } catch {
    cachedSharp = null;
  }
  return cachedSharp;
}

/** True iff sharp is installed and usable on this host. */
export async function isImageProcessingAvailable(): Promise<boolean> {
  return (await loadSharp()) !== null;
}

async function mergeContactSheet(buffers: Buffer[], gridCols: number): Promise<{ buffer: Buffer; mime: string }> {
  const sharp = await loadSharp();
  if (!sharp) {
    throw new Error(
      'image processing unavailable: `sharp` failed to load. Install it explicitly with `npm install sharp` if you need contact-sheet retention.'
    );
  }
  if (buffers.length === 0) {
    throw new Error('No images for contact sheet');
  }
  const thumbs = await Promise.all(
    buffers.map(async (b) => {
      return sharp(b)
        .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
    })
  );
  const metas = await Promise.all(thumbs.map((t) => sharp(t).metadata()));
  const cellW = Math.max(...metas.map((m) => m.width ?? 1));
  const cellH = Math.max(...metas.map((m) => m.height ?? 1));
  const cols = Math.min(gridCols, thumbs.length);
  const rows = Math.ceil(thumbs.length / cols);
  const composites: Array<{ input: Buffer; top: number; left: number }> = [];
  for (let i = 0; i < thumbs.length; i += 1) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const meta = metas[i]!;
    const w = meta.width ?? cellW;
    const h = meta.height ?? cellH;
    const left = col * cellW + Math.floor((cellW - w) / 2);
    const top = row * cellH + Math.floor((cellH - h) / 2);
    const thumb = thumbs[i]!;
    composites.push({ input: thumb, left, top });
  }
  const width = cols * cellW;
  const height = rows * cellH;
  const out = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 32, g: 32, b: 40, alpha: 1 }
    }
  })
    .composite(composites)
    .png()
    .toBuffer();
  return { buffer: out, mime: 'image/png' };
}

export interface KeyframePickContext {
  assetIds: string[];
  /** Short text from neighbouring user messages for ranking. */
  hints: string[];
}

/** Ask text model which asset ids to keep in contact sheet (JSON only). */
export async function pickKeyframesViaModel(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  candidates: KeyframePickContext;
  maxPick: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const { baseUrl, apiKey, model, candidates, maxPick, signal } = input;
  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content:
          `You select up to ${maxPick} most important screenshot asset ids for a contact sheet. Reply ONLY JSON: {"keep":["id1",...]} with ids from the candidate list, ordered by time relevance.`
      },
      {
        role: 'user',
        content: JSON.stringify({
          candidates: candidates.assetIds,
          hints: candidates.hints.slice(0, 20)
        })
      }
    ],
    temperature: 0.2
  };
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Keyframe picker failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  const content = parsed.choices?.[0]?.message?.content?.trim() ?? '';
  try {
    const j = JSON.parse(content) as { keep?: string[] };
    const keep = Array.isArray(j.keep) ? j.keep.map(String) : [];
    return keep.filter((id) => candidates.assetIds.includes(id)).slice(0, maxPick);
  } catch {
    return candidates.assetIds.slice(0, maxPick);
  }
}

/** Heuristic: evenly sample from oldest extras. */
function heuristicKeyframes(ids: string[], maxPick: number): string[] {
  if (ids.length <= maxPick) return ids;
  const step = Math.max(1, Math.floor(ids.length / maxPick));
  const out: string[] = [];
  for (let i = 0; i < ids.length && out.length < maxPick; i += step) {
    out.push(ids[i]!);
  }
  return out.slice(0, maxPick);
}

/**
 * When hot originals exceed limit, compress older ones into a warm contact sheet and mark them cold.
 * Updates session.metadata.imageWarmContactAssetId and appends a short system note (caller may append message).
 */
export async function maintainImageRetention(params: {
  store: SqliteStateStore;
  stateDir: string;
  session: SessionRecord;
  signal?: AbortSignal;
}): Promise<{ contactAsset?: ImageAssetRecord; summaryNote?: string }> {
  const { store, stateDir, session, signal } = params;
  const hotLimit = envInt(process.env, 'RAW_AGENT_IMAGE_HOT_LIMIT', 3);
  const warmKeyframeLimit = envInt(process.env, 'RAW_AGENT_IMAGE_WARM_KEYFRAME_LIMIT', 4);
  const gridCols = envInt(process.env, 'RAW_AGENT_IMAGE_CONTACT_SHEET_GRID', 2);
  const retentionDays = envInt(process.env, 'RAW_AGENT_IMAGE_RETENTION_DAYS', 30);

  const originals = store
    .listImageAssetsForSession(session.id)
    .filter((a) => a.kind === 'original' && a.retentionTier === 'hot')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (originals.length <= hotLimit) {
    await pruneColdAssets(store, stateDir, session.id, retentionDays);
    return {};
  }

  const extras = originals.slice(0, originals.length - hotLimit);
  if (extras.length === 0) {
    return {};
  }

  let pickedIds: string[] = [];
  const useModel = process.env.RAW_AGENT_IMAGE_KEYFRAME_MODEL !== '0';
  const baseUrl = process.env.RAW_AGENT_BASE_URL ?? '';
  const apiKey = process.env.RAW_AGENT_API_KEY ?? '';
  const textModel = process.env.RAW_AGENT_MODEL_NAME ?? '';
  if (useModel && baseUrl && apiKey && textModel) {
    try {
      pickedIds = await pickKeyframesViaModel({
        baseUrl,
        apiKey,
        model: textModel,
        candidates: {
          assetIds: extras.map((e) => e.id),
          hints: [`Session ${session.title}`, ...extras.map((e) => e.sourceUrl ?? e.id)]
        },
        maxPick: warmKeyframeLimit,
        signal
      });
    } catch {
      pickedIds = heuristicKeyframes(
        extras.map((e) => e.id),
        warmKeyframeLimit
      );
    }
  } else {
    pickedIds = heuristicKeyframes(
      extras.map((e) => e.id),
      warmKeyframeLimit
    );
  }

  if (pickedIds.length === 0) {
    pickedIds = extras.map((e) => e.id).slice(0, warmKeyframeLimit);
  }

  const buffers: Buffer[] = [];
  for (const id of pickedIds) {
    try {
      buffers.push(await readImageBuffer(store, stateDir, id));
    } catch {
      /* skip missing */
    }
  }
  if (buffers.length === 0) {
    return {};
  }

  const { buffer: sheetBuf, mime } = await mergeContactSheet(buffers, gridCols);
  const contact = await ingestImageAsset(store, stateDir, {
    sessionId: session.id,
    buffer: sheetBuf,
    mimeType: mime,
    sourceType: 'derived',
    derivedFromIds: pickedIds,
    kind: 'contact_sheet',
    retentionTier: 'warm'
  });

  for (const ex of extras) {
    store.updateImageAsset(ex.id, { retentionTier: 'cold' });
  }

  const meta = { ...(session.metadata ?? {}) };
  meta.imageWarmContactAssetId = contact.id;
  meta.imageVisualSummary = `Compressed ${extras.length} older screenshots into contact sheet ${contact.id} (keyframes: ${pickedIds.join(', ')}).`;
  store.updateSession(session.id, { metadata: meta });

  await pruneColdAssets(store, stateDir, session.id, retentionDays);

  return {
    contactAsset: contact,
    summaryNote: String(meta.imageVisualSummary)
  };
}

async function pruneColdAssets(
  store: SqliteStateStore,
  stateDir: string,
  sessionId: string,
  retentionDays: number
): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const assets = store.listImageAssetsForSession(sessionId);
  for (const a of assets) {
    if (a.retentionTier !== 'cold') continue;
    if (a.createdAt >= cutoff) continue;
    if (a.kind === 'contact_sheet') continue;
    try {
      const abs = join(stateDir, a.localRelPath);
      await unlink(abs);
    } catch {
      /* ignore */
    }
    store.deleteImageAsset(a.id);
  }
}
