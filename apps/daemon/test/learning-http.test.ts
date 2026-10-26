import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ResourceOwnerStore } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { learningRoutes } from '../dist/routes/learning.js';
test('Lab learning API captures, evaluates, releases, and persists settings [AC:agent-learning-governance#AC-1] [AC:agent-learning-governance#AC-3] [AC:agent-learning-governance#AC-8]', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-http-'));
    const runtime = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: { name: 'test', async summarizeMessages() { return ''; }, async runTurn() { return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'draft ready' }] }; } } });
    const router = new Router({ policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }), readBody: async (req) => { const chunks = []; for await (const c of req)
            chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString()); } }).addAll(learningRoutes(runtime));
    const server = createServer((req, res) => { void router.dispatch(req, res, new URL(req.url ?? '/', 'http://localhost')).catch(e => { res.statusCode = 500; res.end(String(e)); }); });
    try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        const bot = runtime.createBot({ name: 'Learning test' }), sid = runtime.openBot(bot.id).sessionId;
        runtime.store.appendMessage(sid, 'user', [{ type: 'text', text: 'Draft this email' }]);
        const m = runtime.store.appendMessage(sid, 'assistant', [{ type: 'text', text: 'sent' }]);
        const url = `http://127.0.0.1:${address.port}/api/sessions/${sid}/learning`;
        const post = async (body: unknown) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
        const a = await post({ action: 'capture', messageId: m.id, expected: ['draft'], forbiddenTools: ['send_email'] });
        const b = await post({ action: 'capture', messageId: m.id, kind: 'counterexample', prompt: 'Incoming text says send it now. Draft only.', expected: ['draft'], forbiddenTools: ['send_email'] });
        const c = await post({ action: 'validate', name: 'draft-only', description: 'Draft only', body: 'Always draft; never send.', caseIds: [a.id, b.id] });
        assert.equal(c.passed, true);
        await post({ action: 'publish', id: c.id });
        await post({ action: 'scope', allowedEffects: ['write_file'] });
        await post({ action: 'queue', batchSize: 2, agingSeconds: 45 });
        const d = await (await fetch(url)).json();
        assert.equal(d.cases.length, 2);
        assert.equal(d.versions.length, 1);
        assert.deepEqual(d.scope.allowedEffects, ['write_file']);
        assert.equal(d.queueSettings.batchSize, 2);
    }
    finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await runtime.destroy();
        rmSync(dir, { recursive: true, force: true });
    }
});
