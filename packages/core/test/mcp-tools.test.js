import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpStdioConfigs, redactStdioFailure, redactStdioTool, sanitizeMcpToolSuffix } from '../dist/mcp/mcp-stdio.js';

// ---------------------------------------------------------------------------
// parseMcpStdioConfigs
// ---------------------------------------------------------------------------
describe('parseMcpStdioConfigs', () => {
  it('returns empty array when RAW_AGENT_MCP_STDIO is missing', () => {
    assert.deepStrictEqual(parseMcpStdioConfigs({}), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepStrictEqual(parseMcpStdioConfigs({ RAW_AGENT_MCP_STDIO: '' }), []);
  });

  it('returns empty array for whitespace-only string', () => {
    assert.deepStrictEqual(parseMcpStdioConfigs({ RAW_AGENT_MCP_STDIO: '   ' }), []);
  });

  it('returns empty array for invalid JSON', () => {
    assert.deepStrictEqual(parseMcpStdioConfigs({ RAW_AGENT_MCP_STDIO: '{bad' }), []);
  });

  it('returns empty array when parsed value is not an array', () => {
    assert.deepStrictEqual(
      parseMcpStdioConfigs({ RAW_AGENT_MCP_STDIO: '{"command":"x"}' }),
      []
    );
  });

  it('returns empty array when parsed value is a string', () => {
    assert.deepStrictEqual(
      parseMcpStdioConfigs({ RAW_AGENT_MCP_STDIO: '"hello"' }),
      []
    );
  });

  it('skips items without a command', () => {
    const env = { RAW_AGENT_MCP_STDIO: JSON.stringify([{ args: ['a'] }]) };
    assert.deepStrictEqual(parseMcpStdioConfigs(env), []);
  });

  it('skips items where command is not a string', () => {
    const env = { RAW_AGENT_MCP_STDIO: JSON.stringify([{ command: 123 }]) };
    assert.deepStrictEqual(parseMcpStdioConfigs(env), []);
  });

  it('skips items where command is empty string', () => {
    const env = { RAW_AGENT_MCP_STDIO: JSON.stringify([{ command: '' }]) };
    assert.deepStrictEqual(parseMcpStdioConfigs(env), []);
  });

  it('parses single server config', () => {
    const cfg = [{ command: 'npx', args: ['mcp-server'], cwd: '/tmp' }];
    const env = { RAW_AGENT_MCP_STDIO: JSON.stringify(cfg) };
    const result = parseMcpStdioConfigs(env);
    assert.equal(result.length, 1);
    assert.equal(result[0].command, 'npx');
    assert.deepStrictEqual(result[0].args, ['mcp-server']);
    assert.equal(result[0].cwd, '/tmp');
  });

  it('parses multiple server configs', () => {
    const cfg = [
      { command: 'node', args: ['server1.js'] },
      { command: 'python', args: ['-m', 'mcp_server'] }
    ];
    const env = { RAW_AGENT_MCP_STDIO: JSON.stringify(cfg) };
    const result = parseMcpStdioConfigs(env);
    assert.equal(result.length, 2);
    assert.equal(result[0].command, 'node');
    assert.equal(result[1].command, 'python');
    assert.deepStrictEqual(result[1].args, ['-m', 'mcp_server']);
  });

  it('includes env sub-object when present', () => {
    const cfg = [{ command: 'node', env: { FOO: 'bar', BAZ: '1' } }];
    const env = { RAW_AGENT_MCP_STDIO: JSON.stringify(cfg) };
    const result = parseMcpStdioConfigs(env);
    assert.equal(result.length, 1);
    assert.deepStrictEqual(result[0].env, { FOO: 'bar', BAZ: '1' });
  });

  it('omits env when not an object', () => {
    const cfg = [{ command: 'node', env: 'not-an-object' }];
    const env = { RAW_AGENT_MCP_STDIO: JSON.stringify(cfg) };
    const result = parseMcpStdioConfigs(env);
    assert.equal(result[0].env, undefined);
  });

  it('omits cwd when not a string', () => {
    const cfg = [{ command: 'node', cwd: 42 }];
    const env = { RAW_AGENT_MCP_STDIO: JSON.stringify(cfg) };
    const result = parseMcpStdioConfigs(env);
    assert.equal(result[0].cwd, undefined);
  });

  it('omits args when not an array', () => {
    const cfg = [{ command: 'node', args: 'not-array' }];
    const env = { RAW_AGENT_MCP_STDIO: JSON.stringify(cfg) };
    const result = parseMcpStdioConfigs(env);
    assert.equal(result[0].args, undefined);
  });

  it('coerces non-string args elements to strings', () => {
    const cfg = [{ command: 'node', args: [1, true, 'ok'] }];
    const env = { RAW_AGENT_MCP_STDIO: JSON.stringify(cfg) };
    const result = parseMcpStdioConfigs(env);
    assert.deepStrictEqual(result[0].args, ['1', 'true', 'ok']);
  });

  it('filters out invalid items while keeping valid ones', () => {
    const cfg = [
      { command: 'valid' },
      { args: ['no-command'] },
      { command: '' },
      { command: 'also-valid', args: ['x'] }
    ];
    const env = { RAW_AGENT_MCP_STDIO: JSON.stringify(cfg) };
    const result = parseMcpStdioConfigs(env);
    assert.equal(result.length, 2);
    assert.equal(result[0].command, 'valid');
    assert.equal(result[1].command, 'also-valid');
  });
});

// ---------------------------------------------------------------------------
// sanitizeMcpToolSuffix
// ---------------------------------------------------------------------------
describe('sanitizeMcpToolSuffix', () => {
  it('keeps alphanumeric names unchanged', () => {
    assert.equal(sanitizeMcpToolSuffix('myTool123'), 'myTool123');
  });

  it('keeps hyphens and underscores', () => {
    assert.equal(sanitizeMcpToolSuffix('my-tool_name'), 'my-tool_name');
  });

  it('replaces special characters with underscores', () => {
    assert.equal(sanitizeMcpToolSuffix('my tool!@#$'), 'my_tool____');
  });

  it('replaces dots and slashes', () => {
    assert.equal(sanitizeMcpToolSuffix('org.example/tool'), 'org_example_tool');
  });

  it('returns "tool" for empty string', () => {
    assert.equal(sanitizeMcpToolSuffix(''), 'tool');
  });

  it('truncates names longer than 56 characters', () => {
    const long = 'a'.repeat(100);
    const result = sanitizeMcpToolSuffix(long);
    assert.equal(result.length, 56);
    assert.equal(result, 'a'.repeat(56));
  });

  it('truncates after replacing special chars', () => {
    const long = 'x!'.repeat(60);
    const result = sanitizeMcpToolSuffix(long);
    assert.equal(result.length, 56);
  });

  it('returns "tool" if all characters are replaced and result is empty after slice', () => {
    // All-space string becomes all underscores, so it's non-empty
    const result = sanitizeMcpToolSuffix('   ');
    assert.equal(result, '___');
  });

  it('handles unicode characters by replacing them', () => {
    assert.equal(sanitizeMcpToolSuffix('工具名'), '___');
  });

  it('preserves mixed valid/invalid characters', () => {
    assert.equal(sanitizeMcpToolSuffix('get:user.info'), 'get_user_info');
  });
});

describe('redactStdioFailure', () => {
  it('strips child env values, including percent-encoded copies', () => {
    const secret = 'stdio/secret';
    const encoded = encodeURIComponent(secret);
    const out = redactStdioFailure(`failed ${secret} and ${encoded}`, { MCP_TOKEN: secret, SHORT: 'abc' });
    assert.equal(out.includes(secret), false);
    assert.equal(out.includes(encoded), false);
    assert.match(out, /\[REDACTED\]/);
    assert.equal(redactStdioFailure('env is production', { NODE_ENV: 'production', PATH: '/usr/bin', MONKEY: 'monkeysecret' }), 'env is production');
  });

  it('redacts AUTHORIZATION and NPM_CONFIG_AUTHTOKEN values', () => {
    const auth = 'bearer-authorization-value';
    const npm = 'npm-authtoken-value';
    const out = redactStdioFailure(`${auth} and ${npm} in production`, {
      AUTHORIZATION: auth,
      NPM_CONFIG_AUTHTOKEN: npm,
      NODE_ENV: 'production'
    });
    assert.equal(out.includes(auth), false);
    assert.equal(out.includes(npm), false);
    assert.match(out, /\[REDACTED\]/);
    assert.match(out, /production/);
  });
});

describe('redactStdioTool', () => {
  it('redacts description text in the schema and keeps enum values such as production', () => {
    const secret = 'supersecretvalue';
    const schema = {
      type: 'object',
      description: `top ${secret}`,
      required: ['production'],
      $ref: `ref-${secret}`,
      properties: {
        production: {
          type: 'string',
          enum: ['production', secret],
          description: `use ${secret} in production`,
          $ref: '#/production'
        },
        [secret]: { type: 'string', description: 'plain label' }
      }
    };
    const tool = {
      name: 'deploy',
      description: `token ${secret} in production`,
      inputSchema: schema,
      readOnlyHint: false
    };
    const out = redactStdioTool(tool, {
      NODE_ENV: 'production',
      MCP_TOKEN: secret,
      SHORT: 'abc',
      PATH: '/usr/bin',
      MONKEY: 'monkeysecret'
    });
    const input = out.inputSchema;
    assert.equal(out.description.includes(secret), false);
    assert.match(out.description, /\[REDACTED\]/);
    assert.match(out.description, /production/);
    assert.equal(input.description.includes(secret), false);
    assert.match(input.description, /\[REDACTED\]/);
    assert.equal(input.properties.production.description.includes(secret), false);
    assert.match(input.properties.production.description, /production/);
    assert.deepEqual(input.properties.production.enum, ['production', secret]);
    assert.deepEqual(input.required, ['production']);
    assert.equal(input.$ref, `ref-${secret}`);
    assert.equal(input.properties.production.$ref, '#/production');
    assert.equal(Object.prototype.hasOwnProperty.call(input.properties, 'production'), true);
    assert.equal(input.properties[secret].description, 'plain label');
    assert.equal(input.properties[secret].type, 'string');
    assert.equal(schema.description, `top ${secret}`);
    assert.equal(schema.properties.production.description, `use ${secret} in production`);
    assert.equal(out.name, 'deploy');
    assert.equal(out.readOnlyHint, false);
  });
});
