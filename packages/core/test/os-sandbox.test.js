import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  MacOSSandboxProvider,
  LinuxBwrapProvider,
  DirectProvider,
  SandboxManager,
  createSandboxFromEnv,
  buildSeatbeltProfile,
  explicitNetworkAllowed,
} from '../dist/sandbox/os-sandbox.js';

// ---------------------------------------------------------------------------
// Seatbelt profile generation (pure function, always testable)
// ---------------------------------------------------------------------------

describe('buildSeatbeltProfile', () => {
  it('generates a valid profile with workspace and home', () => {
    const profile = buildSeatbeltProfile('/workspace', '/Users/test', true);
    assert.ok(profile.includes('(version 1)'));
    assert.ok(profile.includes('(allow default)'));
    assert.ok(profile.includes('(deny file-read* (subpath "/Users/test/.ssh"))'));
    assert.ok(profile.includes('(allow file-write* (subpath "/workspace"))'));
  });

  it('denies all sensitive dirs', () => {
    const profile = buildSeatbeltProfile('/ws', '/home/u', true);
    for (const dir of ['.ssh', '.aws', '.gnupg', '.kube', '.docker']) {
      assert.ok(profile.includes(`/home/u/${dir}`), `Should deny ${dir}`);
    }
  });

  it('adds network deny when allowNetwork=false', () => {
    const profile = buildSeatbeltProfile('/ws', '/home/u', false);
    assert.ok(profile.includes('(deny network*)'));
  });

  it('does NOT add network deny when allowNetwork=true', () => {
    const profile = buildSeatbeltProfile('/ws', '/home/u', true);
    assert.ok(!profile.includes('(deny network*)'));
  });

  it('allows network only when the caller passes true', () => {
    assert.equal(explicitNetworkAllowed(undefined), false);
    assert.equal(explicitNetworkAllowed(false), false);
    assert.equal(explicitNetworkAllowed(true), true);
    assert.ok(buildSeatbeltProfile('/ws', '/home/u', explicitNetworkAllowed(undefined)).includes('(deny network*)'));
    assert.ok(!buildSeatbeltProfile('/ws', '/home/u', explicitNetworkAllowed(true)).includes('(deny network*)'));
  });

  it('allows a union of workspace roots', () => {
    const profile = buildSeatbeltProfile(['/ws/a', '/ws/b'], '/home/u', true);
    assert.ok(profile.includes('(allow file-write* (subpath "/ws/a"))'));
    assert.ok(profile.includes('(allow file-write* (subpath "/ws/b"))'));
  });
});

// ---------------------------------------------------------------------------
// Provider availability
// ---------------------------------------------------------------------------

describe('provider availability', () => {
  it('DirectProvider is always available', () => {
    const p = new DirectProvider();
    assert.equal(p.isAvailable(), true);
    assert.equal(p.tier, 0);
    assert.equal(p.name, 'direct');
  });

  it('MacOSSandboxProvider reports platform-accurate availability', () => {
    const p = new MacOSSandboxProvider();
    if (process.platform === 'darwin') {
      // On newer macOS versions sandbox-exec may exist but refuse sandbox_apply.
      // Availability means "usable for an actual sandboxed process", not just present on disk.
      assert.equal(typeof p.isAvailable(), 'boolean');
    } else {
      assert.equal(p.isAvailable(), false);
    }
    assert.equal(p.tier, 1);
    assert.equal(p.name, 'sandbox-exec');
  });

  it('LinuxBwrapProvider is not available on non-Linux', () => {
    const p = new LinuxBwrapProvider();
    if (process.platform !== 'linux') {
      assert.equal(p.isAvailable(), false);
    }
    assert.equal(p.tier, 1);
    assert.equal(p.name, 'bwrap');
  });
});

// ---------------------------------------------------------------------------
// SandboxManager selection
// ---------------------------------------------------------------------------

describe('SandboxManager', () => {
  it('direct mode always uses DirectProvider', () => {
    const mgr = new SandboxManager('direct');
    assert.equal(mgr.activeProvider.name, 'direct');
    assert.equal(mgr.activeTier, 0);
  });

  it('auto mode selects OS sandbox on macOS, direct elsewhere', () => {
    const mgr = new SandboxManager('auto');
    if (process.platform === 'darwin' && new MacOSSandboxProvider().isAvailable()) {
      assert.equal(mgr.activeProvider.name, 'sandbox-exec');
      assert.equal(mgr.activeTier, 1);
    } else if (process.platform !== 'linux') {
      assert.equal(mgr.activeProvider.name, 'direct');
      assert.equal(mgr.activeTier, 0);
    }
  });

  it('os mode falls back to direct when not available', () => {
    if (process.platform === 'darwin') {
      const mgr = new SandboxManager('os');
      const expected = new MacOSSandboxProvider().isAvailable() ? 'sandbox-exec' : 'direct';
      assert.equal(mgr.activeProvider.name, expected);
    }
    // On unsupported platforms, os mode falls back
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      const mgr = new SandboxManager('os');
      assert.equal(mgr.activeProvider.name, 'direct');
    }
  });

  it('createSandboxFromEnv reads RAW_AGENT_SANDBOX_MODE', () => {
    const prev = process.env.RAW_AGENT_SANDBOX_MODE;
    try {
      process.env.RAW_AGENT_SANDBOX_MODE = 'direct';
      const mgr = createSandboxFromEnv();
      assert.equal(mgr.activeProvider.name, 'direct');
    } finally {
      if (prev === undefined) delete process.env.RAW_AGENT_SANDBOX_MODE;
      else process.env.RAW_AGENT_SANDBOX_MODE = prev;
    }
  });

  it('auto never selects cloudflare-computer', () => {
    const mgr = new SandboxManager('auto');
    assert.notEqual(mgr.activeProvider.name, 'cloudflare-computer');
  });

  it('cloudflare-computer mode stays on that provider', () => {
    const mgr = new SandboxManager('cloudflare-computer');
    assert.equal(mgr.activeProvider.name, 'cloudflare-computer');
    assert.equal(mgr.activeTier, 2);
  });
});

// ---------------------------------------------------------------------------
// DirectProvider execution
// ---------------------------------------------------------------------------

describe('DirectProvider execution', () => {
  it('executes a simple command', async () => {
    const p = new DirectProvider();
    const result = await p.execute('echo hello', {
      cwd: tmpdir(),
      workspace: tmpdir(),
      env: { ...process.env },
    });
    assert.equal(result.tier, 0);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('hello'));
  });

  it('captures stderr', async () => {
    const p = new DirectProvider();
    const result = await p.execute('echo oops >&2', {
      cwd: tmpdir(),
      workspace: tmpdir(),
      env: { ...process.env },
    });
    assert.ok(result.stderr.includes('oops'));
  });

  it('respects timeout', async () => {
    const p = new DirectProvider();
    const result = await p.execute('sleep 30', {
      cwd: tmpdir(),
      workspace: tmpdir(),
      env: { ...process.env },
      timeoutMs: 200,
    });
    assert.ok(result.signal !== null || result.code !== 0);
  });
});

describe('LinuxBwrapProvider integration', { skip: process.platform !== 'linux' }, () => {
  it('a workspace under /tmp stays writable through the private /tmp tmpfs', async (t) => {
    const provider = new LinuxBwrapProvider();
    if (!provider.isAvailable()) return t.skip('bwrap not installed');
    const ws = mkdtempSync(join(tmpdir(), 'bwrap-ws-'));
    writeFileSync(join(ws, 'gone.txt'), 'x');
    const result = await provider.execute('echo hi > made.txt && rm gone.txt && ls', {
      cwd: ws,
      workspace: ws,
      env: { ...process.env },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(join(ws, 'made.txt'), 'utf8'), 'hi\n', 'write must reach the host workspace');
    assert.equal(existsSync(join(ws, 'gone.txt')), false, 'delete must reach the host workspace');
  });
});

// ---------------------------------------------------------------------------
// macOS sandbox-exec integration tests (only on macOS)
// ---------------------------------------------------------------------------

describe('MacOSSandboxProvider integration', { skip: process.platform !== 'darwin' }, () => {
  let provider;

  before(() => {
    provider = new MacOSSandboxProvider();
  });

  it('can run basic commands in sandbox', async () => {
    if (!provider.isAvailable()) return;
    const result = await provider.execute('echo "sandboxed"', {
      cwd: tmpdir(),
      workspace: tmpdir(),
      env: { ...process.env },
    });
    assert.equal(result.tier, 1);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('sandboxed'));
  });

  it('blocks access to ~/.ssh', async () => {
    if (!provider.isAvailable()) return;
    const sshDir = join(homedir(), '.ssh');
    if (!existsSync(sshDir)) return; // skip if no .ssh dir

    const result = await provider.execute(`ls ${sshDir}`, {
      cwd: tmpdir(),
      workspace: tmpdir(),
      env: { ...process.env },
    });
    // Should either fail or show "Operation not permitted"
    assert.ok(
      result.code !== 0 || result.stderr.includes('Operation not permitted'),
      'Should block ~/.ssh access'
    );
  });

  it('blocks access to ~/.aws', async () => {
    if (!provider.isAvailable()) return;
    const awsDir = join(homedir(), '.aws');
    if (!existsSync(awsDir)) return;

    const result = await provider.execute(`ls ${awsDir}`, {
      cwd: tmpdir(),
      workspace: tmpdir(),
      env: { ...process.env },
    });
    assert.ok(
      result.code !== 0 || result.stderr.includes('Operation not permitted'),
      'Should block ~/.aws access'
    );
  });

  it('allows workspace read/write', async () => {
    if (!provider.isAvailable()) return;
    const ws = tmpdir();
    const result = await provider.execute(
      `echo "test" > /tmp/sandbox-test-${process.pid}.txt && cat /tmp/sandbox-test-${process.pid}.txt`,
      {
        cwd: ws,
        workspace: ws,
        env: { ...process.env },
      },
    );
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('test'));
  });

  it('can deny network when allowNetwork=false', async () => {
    if (!provider.isAvailable()) return;
    const result = await provider.execute('curl -s --connect-timeout 2 http://example.com', {
      cwd: tmpdir(),
      workspace: tmpdir(),
      env: { ...process.env },
      allowNetwork: false,
    });
    // Should fail — network denied
    assert.ok(result.code !== 0, 'Network should be denied');
  });

  it('respects timeout', async () => {
    if (!provider.isAvailable()) return;
    const result = await provider.execute('sleep 30', {
      cwd: tmpdir(),
      workspace: tmpdir(),
      env: { ...process.env },
      timeoutMs: 300,
    });
    assert.ok(result.signal !== null || result.code !== 0, 'Should be killed by timeout');
  });
});

// ---------------------------------------------------------------------------
// SandboxManager.execute integration
// ---------------------------------------------------------------------------

describe('SandboxManager.execute', () => {
  it('runs a command and returns result with correct tier', async () => {
    const mgr = new SandboxManager('direct');
    const result = await mgr.execute('echo hi', tmpdir());
    assert.equal(result.tier, 0);
    assert.ok(result.stdout.includes('hi'));
  });

  it('auto mode actually runs the command', async () => {
    const mgr = new SandboxManager('auto');
    const result = await mgr.execute('echo hello', tmpdir());
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('hello'));
    // Tier depends on platform
    if (process.platform === 'darwin' && new MacOSSandboxProvider().isAvailable()) {
      assert.equal(result.tier, 1, 'macOS should use sandbox-exec');
    } else if (process.platform === 'darwin') {
      assert.equal(result.tier, 0, 'macOS should fall back to direct when sandbox-exec is unusable');
    }
  });

  it('strips tool-child credentials and keeps non-secret settings', async () => {
    const mgr = new SandboxManager('direct');
    const result = await mgr.execute(
      'printf %s "$RAW_AGENT_API_KEY|$GITHUB_TOKEN|$RAW_AGENT_MODEL_NAME|$RAW_AGENT_MODEL_CONTEXT_TOKENS|$RAW_AGENT_TOKEN_BUDGET"',
      tmpdir(),
      {
        envOptions: {
          base: {
            PATH: process.env.PATH ?? '/usr/bin',
            RAW_AGENT_API_KEY: 'sk-leak',
            GITHUB_TOKEN: 'ghp-leak',
            RAW_AGENT_MODEL_NAME: 'kept-model',
            RAW_AGENT_MODEL_CONTEXT_TOKENS: '131072',
            RAW_AGENT_TOKEN_BUDGET: 'budget'
          }
        }
      }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '||kept-model|131072|budget');
  });

  it('denies outbound network unless allowNetwork is true', async () => {
    const mgr = new SandboxManager('auto');
    if (mgr.activeTier === 0) return;
    const curl = await mgr.execute('command -v curl', tmpdir(), { allowNetwork: true });
    if (curl.code !== 0) return;
    const denied = await mgr.execute('curl -s --connect-timeout 2 http://example.com', tmpdir());
    assert.notEqual(denied.code, 0);
  });

  it('applies env sanitization (Tier 0) regardless of provider', async () => {
    const prev = process.env.LD_PRELOAD;
    try {
      process.env.LD_PRELOAD = '/tmp/evil.so';
      const mgr = new SandboxManager('direct');
      const result = await mgr.execute('echo $LD_PRELOAD', tmpdir());
      // LD_PRELOAD should be stripped
      assert.ok(!result.stdout.includes('/tmp/evil.so'), 'LD_PRELOAD should be sanitized');
    } finally {
      if (prev === undefined) delete process.env.LD_PRELOAD;
      else process.env.LD_PRELOAD = prev;
    }
  });
});
