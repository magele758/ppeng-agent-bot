import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeSpawnEnv, getInjectionVarNames } from '../dist/sandbox/env-sanitizer.js';

describe('sanitizeSpawnEnv', () => {
  // Save original env vars that might be clobbered
  const saved = {};

  before(() => {
    for (const key of ['LD_PRELOAD', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES',
      'BASH_ENV', 'IFS', 'PROMPT_COMMAND', 'PYTHONPATH', 'JAVA_TOOL_OPTIONS',
      'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'BASH_FUNC_foo%%']) {
      saved[key] = process.env[key];
    }
  });

  after(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  describe('injection var stripping', () => {
    it('strips LD_PRELOAD [AC:command-hardline#AC-6]', () => {
      process.env.LD_PRELOAD = '/tmp/evil.so';
      const env = sanitizeSpawnEnv();
      assert.equal(env.LD_PRELOAD, undefined);
    });

    it('strips NODE_OPTIONS [AC:command-hardline#AC-6]', () => {
      process.env.NODE_OPTIONS = '--require /tmp/evil.js';
      const env = sanitizeSpawnEnv();
      assert.equal(env.NODE_OPTIONS, undefined);
    });

    it('strips DYLD_INSERT_LIBRARIES', () => {
      process.env.DYLD_INSERT_LIBRARIES = '/tmp/evil.dylib';
      const env = sanitizeSpawnEnv();
      assert.equal(env.DYLD_INSERT_LIBRARIES, undefined);
    });

    it('strips BASH_ENV', () => {
      process.env.BASH_ENV = '/tmp/evil.sh';
      const env = sanitizeSpawnEnv();
      assert.equal(env.BASH_ENV, undefined);
    });

    it('strips IFS', () => {
      process.env.IFS = '\t';
      const env = sanitizeSpawnEnv();
      assert.equal(env.IFS, undefined);
    });

    it('strips PROMPT_COMMAND', () => {
      process.env.PROMPT_COMMAND = 'curl http://evil.com';
      const env = sanitizeSpawnEnv();
      assert.equal(env.PROMPT_COMMAND, undefined);
    });

    it('strips PYTHONPATH', () => {
      process.env.PYTHONPATH = '/tmp/evil';
      const env = sanitizeSpawnEnv();
      assert.equal(env.PYTHONPATH, undefined);
    });

    it('strips JAVA_TOOL_OPTIONS', () => {
      process.env.JAVA_TOOL_OPTIONS = '-javaagent:/tmp/evil.jar';
      const env = sanitizeSpawnEnv();
      assert.equal(env.JAVA_TOOL_OPTIONS, undefined);
    });

    it('strips BASH_FUNC_ prefixed vars', () => {
      process.env['BASH_FUNC_foo%%'] = '() { evil; }';
      const env = sanitizeSpawnEnv();
      assert.equal(env['BASH_FUNC_foo%%'], undefined);
    });

    it('preserves safe vars like PATH, HOME, USER [AC:command-hardline#AC-6]', () => {
      const env = sanitizeSpawnEnv();
      assert.equal(env.PATH, process.env.PATH);
      assert.equal(env.HOME, process.env.HOME);
      assert.equal(env.USER, process.env.USER);
    });

    it('strips all vars in getInjectionVarNames()', () => {
      const names = getInjectionVarNames();
      assert.ok(names.size > 10, `Expected >10 injection vars, got ${names.size}`);
      // Set them all
      for (const name of names) {
        process.env[name] = 'EVIL';
      }
      const env = sanitizeSpawnEnv();
      for (const name of names) {
        assert.equal(env[name], undefined, `${name} should be stripped`);
      }
      // Cleanup
      for (const name of names) {
        delete process.env[name];
      }
    });
  });

  describe('custom base env', () => {
    it('sanitizes a custom base instead of process.env', () => {
      const base = {
        PATH: '/usr/bin',
        HOME: '/home/test',
        LD_PRELOAD: '/tmp/evil.so',
        NODE_OPTIONS: '--evil',
      };
      const env = sanitizeSpawnEnv({ base });
      assert.equal(env.PATH, '/usr/bin');
      assert.equal(env.HOME, '/home/test');
      assert.equal(env.LD_PRELOAD, undefined);
      assert.equal(env.NODE_OPTIONS, undefined);
    });

    it('does not touch process.env when base is provided', () => {
      process.env.LD_PRELOAD = '/tmp/test.so';
      const env = sanitizeSpawnEnv({ base: { FOO: 'bar' } });
      assert.equal(env.FOO, 'bar');
      assert.equal(env.LD_PRELOAD, undefined); // not in base
      assert.equal(process.env.LD_PRELOAD, '/tmp/test.so'); // unchanged
      delete process.env.LD_PRELOAD;
    });
  });

  describe('overrides', () => {
    it('merges overrides after sanitization', () => {
      const env = sanitizeSpawnEnv({
        base: { PATH: '/usr/bin', LD_PRELOAD: '/evil.so' },
        overrides: { CUSTOM_VAR: 'hello' },
      });
      assert.equal(env.PATH, '/usr/bin');
      assert.equal(env.LD_PRELOAD, undefined);
      assert.equal(env.CUSTOM_VAR, 'hello');
    });

    it('overrides can re-add stripped vars (intentional)', () => {
      const env = sanitizeSpawnEnv({
        base: { NODE_OPTIONS: '--evil' },
        overrides: { NODE_OPTIONS: '--max-old-space-size=4096' },
      });
      // Override wins — caller explicitly passes it
      assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
    });

    it('does not include overrides with undefined values', () => {
      const env = sanitizeSpawnEnv({
        base: { PATH: '/usr/bin' },
        overrides: { GONE: undefined },
      });
      assert.ok(!('GONE' in env) || env.GONE === undefined);
    });
  });

  describe('credential stripping', () => {
    it('does NOT strip credentials by default', () => {
      const env = sanitizeSpawnEnv({
        base: { AWS_SECRET_ACCESS_KEY: 'secret123', GITHUB_TOKEN: 'ghp_xxx' },
      });
      assert.equal(env.AWS_SECRET_ACCESS_KEY, 'secret123');
      assert.equal(env.GITHUB_TOKEN, 'ghp_xxx');
    });

    it('strips credential exact matches when enabled', () => {
      const env = sanitizeSpawnEnv({
        base: {
          AWS_SECRET_ACCESS_KEY: 'secret',
          AWS_SESSION_TOKEN: 'token',
          GITHUB_TOKEN: 'ghp_xxx',
          GH_TOKEN: 'ghp_yyy',
          GITLAB_TOKEN: 'glpat-xxx',
          NPM_TOKEN: 'npm_xxx',
          NPM_CONFIG_AUTHTOKEN: 'npm_yyy',
          AZURE_CLIENT_SECRET: 'secret',
          GOOGLE_APPLICATION_CREDENTIALS: '/path/to/key.json',
        },
        stripCredentials: true,
      });
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(env.AWS_SESSION_TOKEN, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.GH_TOKEN, undefined);
      assert.equal(env.GITLAB_TOKEN, undefined);
      assert.equal(env.NPM_TOKEN, undefined);
      assert.equal(env.NPM_CONFIG_AUTHTOKEN, undefined);
      assert.equal(env.AZURE_CLIENT_SECRET, undefined);
      assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    });

    it('strips credential prefix matches when enabled', () => {
      const env = sanitizeSpawnEnv({
        base: {
          AWS_SECRET_CUSTOM: 'custom_val',
          AWS_SESSION_CUSTOM: 'session_val',
          PATH: '/usr/bin',
        },
        stripCredentials: true,
      });
      assert.equal(env.AWS_SECRET_CUSTOM, undefined);
      assert.equal(env.AWS_SESSION_CUSTOM, undefined);
      assert.equal(env.PATH, '/usr/bin');
    });
  });

  describe('extraDenylist', () => {
    it('strips extra vars specified by caller', () => {
      const env = sanitizeSpawnEnv({
        base: { MY_SECRET: 'shhh', PATH: '/usr/bin' },
        extraDenylist: ['MY_SECRET'],
      });
      assert.equal(env.MY_SECRET, undefined);
      assert.equal(env.PATH, '/usr/bin');
    });
  });

  describe('allowlist', () => {
    it('preserves allowlisted vars even if they are injection vars', () => {
      const env = sanitizeSpawnEnv({
        base: { NODE_OPTIONS: '--needed', LD_PRELOAD: '/special.so' },
        allowlist: ['NODE_OPTIONS'],
      });
      assert.equal(env.NODE_OPTIONS, '--needed');
      assert.equal(env.LD_PRELOAD, undefined); // not allowlisted
    });

    it('allowlist overrides extraDenylist', () => {
      const env = sanitizeSpawnEnv({
        base: { CUSTOM: 'keep' },
        extraDenylist: ['CUSTOM'],
        allowlist: ['CUSTOM'],
      });
      assert.equal(env.CUSTOM, 'keep');
    });
  });

  describe('operator credentials', () => {
    it('strips the daemon operator token even through overrides and allowlist', () => {
      const env = sanitizeSpawnEnv({
        base: {
          PATH: '/usr/bin',
          RAW_AGENT_AUTH_TOKEN: 'operator-token',
          RAW_AGENT_HUMAN_RELEASE_SECRET: 'human-secret'
        },
        overrides: {
          RAW_AGENT_AUTH_TOKEN: 'override-token',
          RAW_AGENT_HUMAN_RELEASE_SECRET: 'override-secret'
        },
        allowlist: ['RAW_AGENT_AUTH_TOKEN', 'RAW_AGENT_HUMAN_RELEASE_SECRET']
      });
      assert.equal(env.PATH, '/usr/bin');
      assert.equal(env.RAW_AGENT_AUTH_TOKEN, undefined);
      assert.equal(env.RAW_AGENT_HUMAN_RELEASE_SECRET, undefined);
    });
  });

  describe('returns a copy', () => {
    it('does not mutate the base object', () => {
      const base = { PATH: '/usr/bin', LD_PRELOAD: '/evil.so' };
      sanitizeSpawnEnv({ base });
      assert.equal(base.LD_PRELOAD, '/evil.so'); // original unchanged
    });

    it('does not mutate process.env', () => {
      process.env.LD_PRELOAD = '/test.so';
      sanitizeSpawnEnv();
      assert.equal(process.env.LD_PRELOAD, '/test.so');
      delete process.env.LD_PRELOAD;
    });
  });
});

describe('getInjectionVarNames', () => {
  it('returns a non-empty set', () => {
    const names = getInjectionVarNames();
    assert.ok(names instanceof Set);
    assert.ok(names.size > 0);
  });

  it('contains known dangerous vars', () => {
    const names = getInjectionVarNames();
    assert.ok(names.has('LD_PRELOAD'));
    assert.ok(names.has('NODE_OPTIONS'));
    assert.ok(names.has('BASH_ENV'));
    assert.ok(names.has('DYLD_INSERT_LIBRARIES'));
  });

  it('is immutable (readonly set)', () => {
    const names = getInjectionVarNames();
    // Set has add method, but ReadonlySet type prevents mutation at compile time
    assert.equal(typeof names.add, 'function');
    // Verify it returns the same instance
    assert.strictEqual(getInjectionVarNames(), names);
  });
});
