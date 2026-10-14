import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFetchedBodyAsText,
  extractArxivPaperIdFromUrl,
  fetchUrlText,
  sniffHtmlMetaCharset
} from '../dist/tools/web-fetch.js';

// ── arXiv URL id extraction (Atom API path in fetchUrlText) ──

test('extractArxivPaperIdFromUrl parses /abs/', () => {
  assert.equal(
    extractArxivPaperIdFromUrl('https://arxiv.org/abs/2605.08437'),
    '2605.08437'
  );
});

test('extractArxivPaperIdFromUrl parses version suffix', () => {
  assert.equal(
    extractArxivPaperIdFromUrl('https://arxiv.org/abs/2501.06322v2'),
    '2501.06322v2'
  );
});

test('extractArxivPaperIdFromUrl parses /pdf/', () => {
  assert.equal(extractArxivPaperIdFromUrl('https://arxiv.org/pdf/2401.00001.pdf'), '2401.00001');
});

test('extractArxivPaperIdFromUrl parses /html/', () => {
  assert.equal(
    extractArxivPaperIdFromUrl('https://arxiv.org/html/2501.06322v1'),
    '2501.06322v1'
  );
});

test('extractArxivPaperIdFromUrl returns null for non-arxiv', () => {
  assert.equal(extractArxivPaperIdFromUrl('https://example.com/abs/2501.06322'), null);
});

test('extractArxivPaperIdFromUrl returns null for arxiv host without id in path', () => {
  assert.equal(extractArxivPaperIdFromUrl('https://arxiv.org/'), null);
});

// ── HTML / Content-Type decoding (web agents) ──

test('decodeFetchedBodyAsText uses Content-Type charset', () => {
  const buf = Buffer.from('<html><body>Café</body></html>', 'latin1');
  const text = decodeFetchedBodyAsText(new Uint8Array(buf), 'text/html; charset=iso-8859-1');
  assert.ok(text.includes('Café'));
});

test('decodeFetchedBodyAsText uses meta charset when header omits charset', () => {
  const buf = Buffer.concat([
    Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>Caf', 'utf8'),
    Buffer.from([0xe9]),
    Buffer.from('</body></html>', 'utf8')
  ]);
  const text = decodeFetchedBodyAsText(new Uint8Array(buf), 'text/html');
  assert.ok(text.includes('Café'));
});

test('decodeFetchedBodyAsText reads charset from meta http-equiv when content precedes http-equiv', () => {
  const buf = Buffer.concat([
    Buffer.from(
      '<html><head><meta content="text/html; charset=iso-8859-1" http-equiv="Content-Type"></head><body>Caf',
      'utf8'
    ),
    Buffer.from([0xe9]),
    Buffer.from('</body></html>', 'utf8')
  ]);
  const text = decodeFetchedBodyAsText(new Uint8Array(buf), 'text/html');
  assert.ok(text.includes('Café'));
});

test('sniffHtmlMetaCharset maps gb2312 label to gbk', () => {
  const buf = Buffer.from('<html><head><meta charset="gb2312"></head></html>', 'utf8');
  assert.equal(sniffHtmlMetaCharset(new Uint8Array(buf)), 'gbk');
});

// ── SSRF guard (isPrivateIp tested indirectly via fetchUrlText) ──

test('fetchUrlText blocks localhost', async () => {
  const result = await fetchUrlText({ url: 'http://localhost/secret' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('private'));
});

test('fetchUrlText blocks 127.0.0.1', async () => {
  const result = await fetchUrlText({ url: 'http://127.0.0.1/secret' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('private'));
});

test('fetchUrlText blocks 10.x.x.x', async () => {
  const result = await fetchUrlText({ url: 'http://10.0.0.1/admin' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('private'));
});

test('fetchUrlText blocks 192.168.x.x', async () => {
  const result = await fetchUrlText({ url: 'http://192.168.1.1/' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('private'));
});

test('fetchUrlText blocks 172.16-31.x.x', async () => {
  const result = await fetchUrlText({ url: 'http://172.16.0.1/' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('private'));
});

test('fetchUrlText blocks 169.254.x.x (link-local)', async () => {
  const result = await fetchUrlText({ url: 'http://169.254.169.254/metadata' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('private'));
});

test('fetchUrlText blocks 0.0.0.0', async () => {
  const result = await fetchUrlText({ url: 'http://0.0.0.0/' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('private'));
});

test('fetchUrlText blocks IPv6 loopback ::1', async () => {
  const result = await fetchUrlText({ url: 'http://[::1]/' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('private'));
});

test('fetchUrlText allows private hosts when allowPrivateHosts=true', async () => {
  // This will fail to connect but NOT be blocked by SSRF guard
  const result = await fetchUrlText({ url: 'http://127.0.0.1:19999/', allowPrivateHosts: true, timeoutMs: 500 });
  // Should get a connection/fetch error, not a "private" rejection
  assert.equal(result.ok, false);
  assert.ok(!result.content.includes('private'));
});

// ── URL validation ──

test('fetchUrlText rejects invalid URL', async () => {
  const result = await fetchUrlText({ url: 'not-a-url' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('Invalid URL'));
});

test('fetchUrlText rejects non-http protocols', async () => {
  const result = await fetchUrlText({ url: 'ftp://example.com/file' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('http(s)'));
});

test('fetchUrlText rejects file:// protocol', async () => {
  const result = await fetchUrlText({ url: 'file:///etc/passwd' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('http(s)'));
});

// ── 172.x edge cases ──

test('fetchUrlText allows 172.15.x.x (not in private range)', async () => {
  // 172.15 is NOT private (only 172.16-31 is private)
  // This will fail to connect but should NOT be blocked by SSRF
  const result = await fetchUrlText({ url: 'http://172.15.0.1:19999/', timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.ok(!result.content.includes('private'));
});

test('fetchUrlText blocks 172.31.x.x (top of private range)', async () => {
  const result = await fetchUrlText({ url: 'http://172.31.255.255/' });
  assert.equal(result.ok, false);
  assert.ok(result.content.includes('private'));
});

test('fetchUrlText allows 172.32.x.x (above private range)', async () => {
  const result = await fetchUrlText({ url: 'http://172.32.0.1:19999/', timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.ok(!result.content.includes('private'));
});

function pinned(request, resolveHost = async () => ['93.184.216.34']) {
  return { resolveHost, request, allowPrivateHosts: false };
}

test('fetchUrlText blocks CGNAT, mapped IPv6, and decimal loopback without connecting', async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    return new Response('no');
  };
  for (const url of [
    'http://100.64.0.1/',
    'http://100.127.255.255/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://2130706433/',
    'http://0x7f000001/'
  ]) {
    const result = await fetchUrlText({ url, ...pinned(request) });
    assert.equal(result.ok, false, url);
    assert.match(result.content, /private/, url);
  }
  assert.equal(calls, 0);
});

test('fetchUrlText refuses a name that resolves to loopback or metadata', async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    return new Response('secret');
  };
  for (const address of ['127.0.0.1', '::1', '169.254.169.254', '10.1.2.3', '100.64.1.1']) {
    const result = await fetchUrlText({
      url: 'https://public.example/page',
      ...pinned(request, async () => [address])
    });
    assert.equal(result.ok, false, address);
    assert.match(result.content, /private/, address);
  }
  const mixed = await fetchUrlText({
    url: 'https://public.example/page',
    ...pinned(request, async () => ['93.184.216.34', '127.0.0.1'])
  });
  assert.equal(mixed.ok, false);
  assert.match(mixed.content, /private/);
  assert.equal(calls, 0);
});

test('fetchUrlText pins the approved address and rechecks each redirect', async () => {
  const seen = [];
  const result = await fetchUrlText({
    url: 'https://public.example/start',
    ...pinned(async (url, address) => {
      seen.push(`${url.hostname}@${address}`);
      if (url.pathname === '/start') {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example/next' } });
      }
      return new Response('pinned-body', { status: 200, headers: { 'content-type': 'text/plain' } });
    }, async (hostname) => (hostname === 'cdn.example' ? ['203.0.113.10'] : ['93.184.216.34']))
  });
  assert.equal(result.ok, true);
  assert.match(result.content, /pinned-body/);
  assert.deepEqual(seen, ['public.example@93.184.216.34', 'cdn.example@203.0.113.10']);
});

test('fetchUrlText does not follow a redirect into a private address', async () => {
  let calls = 0;
  const result = await fetchUrlText({
    url: 'https://public.example/start',
    ...pinned(async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    })
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.match(result.content, /private/);
});

test('fetchUrlText stops a redirect loop', async () => {
  let calls = 0;
  const result = await fetchUrlText({
    url: 'http://203.0.113.10/start',
    timeoutMs: 1000,
    request: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: 'http://203.0.113.10/again' } });
    }
  });
  assert.equal(result.ok, false);
  assert.ok(calls >= 2 && calls <= 6);
});
