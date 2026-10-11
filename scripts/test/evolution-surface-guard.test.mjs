import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evolutionRoutes } from '../../apps/daemon/dist/evolution-api.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000
  });
}

test('POST /api/evolution/start returns evolution_disabled [AC:ops-console#AC-9]', async () => {
  const route = evolutionRoutes('/tmp').find((r) => r.method === 'POST' && r.pattern === '/api/evolution/start');
  assert.ok(route);
  let status = 0;
  let body = '';
  const response = {
    setHeader() {},
    end(payload) {
      body = String(payload);
    }
  };
  Object.defineProperty(response, 'statusCode', {
    set(value) {
      status = value;
    }
  });
  await route.handler({ response });
  assert.equal(status, 409);
  assert.equal(JSON.parse(body).code, 'evolution_disabled');
});

test('evolution CLI and cron example do not start a run [AC:ops-console#AC-9]', () => {
  const cli = runNode(['scripts/evolution-cli.mjs', '--learn', '--agent', 'claude']);
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.match(cli.stderr, /evolution_disabled/);
  assert.doesNotMatch(`${cli.stdout}\n${cli.stderr}`, /run-day|evolution-learn: inbox/);

  const guard = runNode(['scripts/evolution/refuse-if-hidden.mjs']);
  assert.equal(guard.status, 3);
  assert.match(guard.stderr, /evolution_disabled/);

  const pipeline = spawnSync('bash', ['scripts/evolution-pipeline.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000
  });
  assert.equal(pipeline.status, 0, pipeline.stderr || pipeline.stdout);
  assert.match(pipeline.stderr, /evolution_disabled/);
  assert.doesNotMatch(`${pipeline.stdout}\n${pipeline.stderr}`, /evolution-pipeline\] 默认/);
});
