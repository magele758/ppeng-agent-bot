// Fetch only the public entry shell from this Next process. Authentication
// still happens in the browser through the normal same-origin auth endpoint.
export const dynamic = 'force-dynamic';

export async function GET() {
  const origin = 'http://127.0.0.1:' + (process.env.PORT || '3000');
  const upstream = await fetch(new URL('/', origin), {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000)
  });
  if (!upstream.ok) return new Response(null, { status: upstream.status });
  const nonce = crypto.randomUUID();
  // Execute the recovered entry scripts in document order before the
  // streamed component payload can request the original failed chunk URL.
  const scripts: string[] = [];
  const shell = (await upstream.text())
    .replace(/<script src="\/_next\/static\/[^"]+" async=""><\/script>/g, tag => {
      scripts.push(tag.replace(' async=""', ''));
      return '';
    })
    .replace('</body>', () => scripts.filter(tag => !tag.includes('/main-app-')).join('') +
      scripts.filter(tag => tag.includes('/main-app-')).join('') + '</body>')
    .replace(/(name="labRetry" value=")1"/g, (_, prefix: string) => prefix + nonce + '"');
  const html = shell.replace(
    /\b(src|href)="(\/_next\/static\/[^"]+)"/g,
    (_, attr: string, path: string) => attr + '="' + path + (path.includes('?') ? '&amp;' : '?') + 'labBoot=' + nonce + '"'
  );
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
