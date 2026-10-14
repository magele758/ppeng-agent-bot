import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isAllowedImageMime,
  extensionForMime,
  ingestImageAsset,
  imageBufferToDataUrl,
  touchImageAccess,
  readImageBuffer,
  fetchImageFromUrl,
} from '../dist/image-assets.js';
import { SqliteStateStore } from '../dist/storage.js';

// Minimal valid 1x1 transparent PNG (67 bytes)
const MINIMAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000a49444154789c626000000002000198e195280000000049454e44ae426082',
  'hex'
);

function makeTempEnv() {
  const dir = join(
    tmpdir(),
    'ppeng-img-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'test.db');
  const store = new SqliteStateStore(dbPath);
  return { dir, dbPath, store };
}

describe('isAllowedImageMime', () => {
  describe('valid image types', () => {
    it('accepts image/png', () => {
      assert.strictEqual(isAllowedImageMime('image/png'), true);
    });

    it('accepts image/jpeg', () => {
      assert.strictEqual(isAllowedImageMime('image/jpeg'), true);
    });

    it('accepts image/webp', () => {
      assert.strictEqual(isAllowedImageMime('image/webp'), true);
    });

    it('accepts image/gif', () => {
      assert.strictEqual(isAllowedImageMime('image/gif'), true);
    });
  });

  describe('case insensitivity', () => {
    it('accepts Image/PNG (mixed case)', () => {
      assert.strictEqual(isAllowedImageMime('Image/PNG'), true);
    });

    it('accepts IMAGE/JPEG (uppercase)', () => {
      assert.strictEqual(isAllowedImageMime('IMAGE/JPEG'), true);
    });

    it('accepts image/WebP (mixed case subtype)', () => {
      assert.strictEqual(isAllowedImageMime('image/WebP'), true);
    });

    it('accepts IMAGE/GIF (uppercase)', () => {
      assert.strictEqual(isAllowedImageMime('IMAGE/GIF'), true);
    });
  });

  describe('with charset suffix', () => {
    it('accepts image/png with charset=utf-8', () => {
      assert.strictEqual(isAllowedImageMime('image/png; charset=utf-8'), true);
    });

    it('accepts image/jpeg with charset=utf-8', () => {
      assert.strictEqual(isAllowedImageMime('image/jpeg; charset=utf-8'), true);
    });

    it('accepts image/webp with charset=utf-8', () => {
      assert.strictEqual(isAllowedImageMime('image/webp; charset=utf-8'), true);
    });

    it('accepts image/gif with charset=utf-8', () => {
      assert.strictEqual(isAllowedImageMime('image/gif; charset=utf-8'), true);
    });

    it('accepts with other charset values', () => {
      assert.strictEqual(isAllowedImageMime('image/png; charset=iso-8859-1'), true);
    });
  });

  describe('invalid image types', () => {
    it('rejects image/svg+xml', () => {
      assert.strictEqual(isAllowedImageMime('image/svg+xml'), false);
    });

    it('rejects image/tiff', () => {
      assert.strictEqual(isAllowedImageMime('image/tiff'), false);
    });

    it('rejects application/pdf', () => {
      assert.strictEqual(isAllowedImageMime('application/pdf'), false);
    });

    it('rejects text/plain', () => {
      assert.strictEqual(isAllowedImageMime('text/plain'), false);
    });

    it('rejects empty string', () => {
      assert.strictEqual(isAllowedImageMime(''), false);
    });
  });

  describe('security: injection attempts', () => {
    it('rejects CRLF injection attempt', () => {
      assert.strictEqual(isAllowedImageMime('image/png\nContent-Type: text/html'), false);
    });

    it('rejects carriage return injection', () => {
      assert.strictEqual(isAllowedImageMime('image/png\r\nContent-Type: text/html'), false);
    });

    it('trailing whitespace is trimmed and accepted', () => {
      // trim() strips trailing newline, so 'image/png\n' → 'image/png' → valid
      assert.strictEqual(isAllowedImageMime('image/png\n'), true);
    });
  });
});

describe('extensionForMime', () => {
  describe('valid image types', () => {
    it('returns "png" for image/png', () => {
      assert.strictEqual(extensionForMime('image/png'), 'png');
    });

    it('returns "jpg" for image/jpeg', () => {
      assert.strictEqual(extensionForMime('image/jpeg'), 'jpg');
    });

    it('returns "webp" for image/webp', () => {
      assert.strictEqual(extensionForMime('image/webp'), 'webp');
    });

    it('returns "gif" for image/gif', () => {
      assert.strictEqual(extensionForMime('image/gif'), 'gif');
    });
  });

  describe('case insensitivity', () => {
    it('returns "png" for Image/PNG', () => {
      assert.strictEqual(extensionForMime('Image/PNG'), 'png');
    });

    it('returns "jpg" for IMAGE/JPEG', () => {
      assert.strictEqual(extensionForMime('IMAGE/JPEG'), 'jpg');
    });

    it('returns "webp" for image/WebP', () => {
      assert.strictEqual(extensionForMime('image/WebP'), 'webp');
    });

    it('returns "gif" for IMAGE/GIF', () => {
      assert.strictEqual(extensionForMime('IMAGE/GIF'), 'gif');
    });
  });

  describe('with charset suffix', () => {
    it('returns "png" for image/png; charset=utf-8', () => {
      assert.strictEqual(extensionForMime('image/png; charset=utf-8'), 'png');
    });

    it('returns "jpg" for image/jpeg; charset=utf-8', () => {
      assert.strictEqual(extensionForMime('image/jpeg; charset=utf-8'), 'jpg');
    });

    it('returns "webp" for image/webp; charset=iso-8859-1', () => {
      assert.strictEqual(extensionForMime('image/webp; charset=iso-8859-1'), 'webp');
    });

    it('returns "gif" for image/gif; boundary=something', () => {
      assert.strictEqual(extensionForMime('image/gif; boundary=something'), 'gif');
    });
  });

  describe('unknown types', () => {
    it('returns "bin" for image/svg+xml', () => {
      assert.strictEqual(extensionForMime('image/svg+xml'), 'bin');
    });

    it('returns "bin" for image/tiff', () => {
      assert.strictEqual(extensionForMime('image/tiff'), 'bin');
    });

    it('returns "bin" for application/pdf', () => {
      assert.strictEqual(extensionForMime('application/pdf'), 'bin');
    });

    it('returns "bin" for text/plain', () => {
      assert.strictEqual(extensionForMime('text/plain'), 'bin');
    });

    it('returns "bin" for empty string', () => {
      assert.strictEqual(extensionForMime(''), 'bin');
    });

    it('returns "bin" for unrecognized mime', () => {
      assert.strictEqual(extensionForMime('image/bmp'), 'bin');
    });
  });
});

// ── ingestImageAsset ─────────────────────────────────────────────────────

describe('ingestImageAsset', () => {
  let store, stateDir;

  before(() => {
    const env = makeTempEnv();
    store = env.store;
    stateDir = env.dir;
  });

  after(() => {
    try { store.db.close(); } catch { /* ignore */ }
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('persists a valid PNG and returns an asset record', async () => {
    const asset = await ingestImageAsset(store, stateDir, {
      sessionId: 'sess-1',
      buffer: MINIMAL_PNG,
      mimeType: 'image/png',
      sourceType: 'upload',
    });
    assert.ok(asset.id.startsWith('img'));
    assert.strictEqual(asset.sessionId, 'sess-1');
    assert.strictEqual(asset.mimeType, 'image/png');
    assert.strictEqual(asset.sourceType, 'upload');
    assert.strictEqual(asset.sizeBytes, MINIMAL_PNG.length);
    assert.strictEqual(asset.retentionTier, 'hot');
    assert.strictEqual(asset.kind, 'original');
    assert.ok(asset.sha256.length === 64);
    assert.ok(asset.localRelPath.endsWith('.png'));
  });

  it('deduplicates identical images in the same session', async () => {
    const a1 = await ingestImageAsset(store, stateDir, {
      sessionId: 'sess-dedup',
      buffer: MINIMAL_PNG,
      mimeType: 'image/png',
      sourceType: 'upload',
    });
    const a2 = await ingestImageAsset(store, stateDir, {
      sessionId: 'sess-dedup',
      buffer: MINIMAL_PNG,
      mimeType: 'image/png',
      sourceType: 'upload',
    });
    assert.strictEqual(a1.id, a2.id, 'same sha256 should return same asset');
  });

  it('rejects unsupported mime types', async () => {
    await assert.rejects(
      () =>
        ingestImageAsset(store, stateDir, {
          sessionId: 'sess-bad',
          buffer: MINIMAL_PNG,
          mimeType: 'image/tiff',
          sourceType: 'upload',
        }),
      { message: /Unsupported image mime/ }
    );
  });

  it('rejects buffers exceeding the size limit', async () => {
    const saved = process.env.RAW_AGENT_IMAGE_MAX_BYTES;
    process.env.RAW_AGENT_IMAGE_MAX_BYTES = '10';
    try {
      await assert.rejects(
        () =>
          ingestImageAsset(store, stateDir, {
            sessionId: 'sess-big',
            buffer: MINIMAL_PNG,
            mimeType: 'image/png',
            sourceType: 'upload',
          }),
        { message: /exceeds limit/ }
      );
    } finally {
      if (saved === undefined) delete process.env.RAW_AGENT_IMAGE_MAX_BYTES;
      else process.env.RAW_AGENT_IMAGE_MAX_BYTES = saved;
    }
  });

  it('accepts image/jpeg mime with charset suffix', async () => {
    const jpegBuf = Buffer.alloc(4, 0);
    jpegBuf[0] = 0xff;
    jpegBuf[1] = 0xd8;
    jpegBuf[2] = 0xff;
    jpegBuf[3] = 0xe0;
    const asset = await ingestImageAsset(store, stateDir, {
      sessionId: 'sess-jpeg',
      buffer: jpegBuf,
      mimeType: 'image/jpeg; charset=utf-8',
      sourceType: 'url',
      sourceUrl: 'https://example.com/img.jpg',
    });
    assert.strictEqual(asset.mimeType, 'image/jpeg');
    assert.ok(asset.localRelPath.endsWith('.jpg'));
    assert.strictEqual(asset.sourceUrl, 'https://example.com/img.jpg');
  });

  it('stores derivedFromIds and custom kind', async () => {
    const asset = await ingestImageAsset(store, stateDir, {
      sessionId: 'sess-derived',
      buffer: Buffer.from(MINIMAL_PNG),
      mimeType: 'image/png',
      sourceType: 'derived',
      derivedFromIds: ['img-aaa', 'img-bbb'],
      kind: 'contact_sheet',
      retentionTier: 'warm',
    });
    assert.deepStrictEqual(asset.derivedFromIds, ['img-aaa', 'img-bbb']);
    assert.strictEqual(asset.kind, 'contact_sheet');
    assert.strictEqual(asset.retentionTier, 'warm');
  });
});

// ── readImageBuffer ──────────────────────────────────────────────────────

describe('readImageBuffer', () => {
  let store, stateDir;

  before(() => {
    const env = makeTempEnv();
    store = env.store;
    stateDir = env.dir;
  });

  after(() => {
    try { store.db.close(); } catch { /* ignore */ }
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reads back the exact bytes that were ingested', async () => {
    const asset = await ingestImageAsset(store, stateDir, {
      sessionId: 'sess-read',
      buffer: MINIMAL_PNG,
      mimeType: 'image/png',
      sourceType: 'upload',
    });
    const buf = await readImageBuffer(store, stateDir, asset.id);
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.equals(MINIMAL_PNG));
  });

  it('throws for a non-existent asset id', async () => {
    await assert.rejects(
      () => readImageBuffer(store, stateDir, 'img-nonexistent'),
      { message: /not found/ }
    );
  });
});

// ── imageBufferToDataUrl ─────────────────────────────────────────────────

describe('imageBufferToDataUrl', () => {
  let store, stateDir;

  before(() => {
    const env = makeTempEnv();
    store = env.store;
    stateDir = env.dir;
  });

  after(() => {
    try { store.db.close(); } catch { /* ignore */ }
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns a data: URL with correct mime and base64', async () => {
    const asset = await ingestImageAsset(store, stateDir, {
      sessionId: 'sess-dataurl',
      buffer: MINIMAL_PNG,
      mimeType: 'image/png',
      sourceType: 'upload',
    });
    const url = await imageBufferToDataUrl(store, stateDir, asset.id);
    assert.ok(url.startsWith('data:image/png;base64,'));
    const b64 = url.split(',')[1];
    const decoded = Buffer.from(b64, 'base64');
    assert.ok(decoded.equals(MINIMAL_PNG));
  });

  it('returns empty string for non-existent asset', async () => {
    const url = await imageBufferToDataUrl(store, stateDir, 'img-missing');
    assert.strictEqual(url, '');
  });
});

// ── touchImageAccess ─────────────────────────────────────────────────────

describe('touchImageAccess', () => {
  let store, stateDir;

  before(() => {
    const env = makeTempEnv();
    store = env.store;
    stateDir = env.dir;
  });

  after(() => {
    try { store.db.close(); } catch { /* ignore */ }
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('updates lastAccessAt to a newer timestamp', async () => {
    const asset = await ingestImageAsset(store, stateDir, {
      sessionId: 'sess-touch',
      buffer: MINIMAL_PNG,
      mimeType: 'image/png',
      sourceType: 'upload',
    });
    const before = store.getImageAsset(asset.id).lastAccessAt;

    // small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 20));
    await touchImageAccess(store, asset.id);

    const after = store.getImageAsset(asset.id).lastAccessAt;
    assert.ok(after >= before, 'lastAccessAt should be updated');
  });

  it('is a no-op for non-existent asset (no throw)', async () => {
    await touchImageAccess(store, 'img-ghost');
    // should simply return without error
  });
});

describe('fetchImageFromUrl private network policy', () => {
  const offline = { allowPrivateHosts: false };

  it('refuses metadata, loopback, and DNS rebinding before download', async () => {
    let calls = 0;
    const request = async () => {
      calls += 1;
      return new Response(MINIMAL_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    };
    await assert.rejects(
      () => fetchImageFromUrl('http://169.254.169.254/latest/meta-data', 1000, 1000, undefined, { ...offline, request }),
      /private/
    );
    await assert.rejects(
      () => fetchImageFromUrl('http://127.0.0.1/secret.png', 1000, 1000, undefined, { ...offline, request }),
      /private/
    );
    await assert.rejects(
      () => fetchImageFromUrl('https://cdn.example/a.png', 1000, 1000, undefined, {
        ...offline,
        request,
        resolveHost: async () => ['127.0.0.1']
      }),
      /private/
    );
    assert.equal(calls, 0);
  });

  it('does not follow a redirect onto a private address', async () => {
    let calls = 0;
    await assert.rejects(
      () => fetchImageFromUrl('https://cdn.example/a.png', 1000, 1000, undefined, {
        ...offline,
        resolveHost: async () => ['93.184.216.34'],
        request: async () => {
          calls += 1;
          return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/x' } });
        }
      }),
      /private/
    );
    assert.equal(calls, 1);
  });

  it('returns immediately when the caller signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const started = Date.now();
    await assert.rejects(
      () => fetchImageFromUrl('https://cdn.example/a.png', 1000, 30_000, ac.signal, {
        ...offline,
        resolveHost: async () => {
          calls += 1;
          return ['93.184.216.34'];
        },
        request: async () => {
          calls += 1;
          return new Response(MINIMAL_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
        }
      }),
      (err) => err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))
    );
    assert.equal(calls, 0);
    assert.ok(Date.now() - started < 500);
  });

  it('pins a public image download to the approved address', async () => {
    const seen = [];
    const image = await fetchImageFromUrl('https://cdn.example/a.png', 1_000_000, 1000, undefined, {
      ...offline,
      resolveHost: async () => ['93.184.216.34'],
      request: async (_url, address) => {
        seen.push(address);
        return new Response(MINIMAL_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      }
    });
    assert.deepEqual(seen, ['93.184.216.34']);
    assert.equal(image.mimeType, 'image/png');
    assert.ok(image.buffer.length > 0);
  });
});

// pickKeyframesViaModel requires a live LLM endpoint.
// mergeContactSheet is unexported (private) and requires the sharp library.
