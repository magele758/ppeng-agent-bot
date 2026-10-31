import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ValidationError } from '@ppeng/agent-core';
import { registeredMachinesRoutes } from '../dist/routes/registered-machines.js';
import type { RouteSpec } from '../dist/routing.js';

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'registered-machines-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'registered-machines-test',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  return { dir, runtime, routes: registeredMachinesRoutes(runtime) };
}

interface MockResponse {
  statusCode: number;
  setHeader(key: string, value: string): void;
  end(raw: string): void;
}

interface CallPostResult {
  status: number;
  body: Record<string, unknown>;
}

async function callPost(
  routes: RouteSpec[],
  body: unknown,
  auth?: { user?: { id: string; tenantId: string } }
): Promise<CallPostResult> {
  const spec = routes.find((route) => route.method === 'POST' && route.pattern === '/api/registered-machines')!;
  const out: CallPostResult = { status: 0, body: {} };
  const response: MockResponse = {
    statusCode: 0,
    setHeader() {},
    end(raw: string) {
      out.status = this.statusCode;
      out.body = JSON.parse(raw) as Record<string, unknown>;
    }
  };
  await spec.handler({
    readBody: async () => body,
    response,
    auth: auth || { user: undefined }
  } as never);
  return out;
}

test('POST /api/registered-machines registers a machine with valid machineId, label, and kind', async () => {
  const { dir, runtime, routes } = boot();
  try {
    const response = await callPost(routes, {
      machineId: 'test-machine-001',
      label: 'Test Machine',
      kind: 'desktop'
    });
    assert.equal(response.status, 201);
    assert.ok(response.body.machine);
    const machine = response.body.machine as Record<string, unknown>;
    assert.equal(machine.machineId, 'test-machine-001');
    assert.equal(machine.label, 'Test Machine');
    assert.equal(machine.kind, 'desktop');
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/registered-machines validates missing machineId [BRANCH: validation]', async () => {
  const { dir, runtime, routes } = boot();
  try {
    await assert.rejects(
      () =>
        callPost(routes, {
          label: 'Test Machine',
          kind: 'desktop'
        }),
      ValidationError
    );
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/registered-machines validates missing label [BRANCH: validation]', async () => {
  const { dir, runtime, routes } = boot();
  try {
    await assert.rejects(
      () =>
        callPost(routes, {
          machineId: 'test-machine-001',
          kind: 'desktop'
        }),
      ValidationError
    );
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/registered-machines validates missing kind [BRANCH: validation]', async () => {
  const { dir, runtime, routes } = boot();
  try {
    await assert.rejects(
      () =>
        callPost(routes, {
          machineId: 'test-machine-001',
          label: 'Test Machine'
        }),
      ValidationError
    );
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/registered-machines handles empty string fields as missing [BRANCH: field validation]', async () => {
  const { dir, runtime, routes } = boot();
  try {
    await assert.rejects(
      () =>
        callPost(routes, {
          machineId: '',
          label: 'Test Machine',
          kind: 'desktop'
        }),
      ValidationError
    );
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/registered-machines ignores non-string field types [BRANCH: type coercion]', async () => {
  const { dir, runtime, routes } = boot();
  try {
    await assert.rejects(
      () =>
        callPost(routes, {
          machineId: 123,
          label: 'Test Machine',
          kind: 'desktop'
        }),
      ValidationError
    );
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/registered-machines accepts authenticated user context', async () => {
  const { dir, runtime, routes } = boot();
  try {
    const response = await callPost(
      routes,
      {
        machineId: 'test-machine-001',
        label: 'Test Machine',
        kind: 'desktop'
      },
      {
        user: { id: 'user-123', tenantId: 'tenant-456' }
      }
    );
    assert.equal(response.status, 201);
    assert.ok(response.body.machine);
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/registered-machines handles empty body gracefully [BRANCH: empty body]', async () => {
  const { dir, runtime, routes } = boot();
  try {
    await assert.rejects(() => callPost(routes, {}), ValidationError);
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/registered-machines handles null body gracefully [BRANCH: null body]', async () => {
  const { dir, runtime, routes } = boot();
  try {
    await assert.rejects(() => callPost(routes, null), ValidationError);
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
