import test from 'node:test';
import assert from 'node:assert/strict';
import { launchDevLab, stolenPortFailure } from '../dev-lab.mjs';

test('a port stolen after selection is retried without recompiling [AC:pnpm-migration#AC-3]', async () => {
  assert.equal(stolenPortFailure('Error: listen EADDRINUSE: address already in use 0.0.0.0:44224', 1), true);
  assert.equal(stolenPortFailure('Error: listen EADDRINUSE', 130), false);
  assert.equal(stolenPortFailure('compile failed', 1), false);
  const calls = [];
  const code = await launchDevLab({
    env: { RAW_AGENT_DAEMON_PORT: '44000', RAW_AGENT_WEB_PORT: '44010', RAW_AGENT_PORT_SPAN: '5', PATH: process.env.PATH },
    pick: async (preferred) => preferred,
    writePorts: () => {},
    log: { log() {}, warn() {} },
    run: async (spec) => {
      calls.push(spec);
      if (calls.length === 1) {
        spec.onOutput('web', 'Error: listen EADDRINUSE: address already in use 0.0.0.0:44010');
        return 1;
      }
      return 0;
    }
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].build);
  assert.equal(calls[1].build, undefined);
  const portOf = (spec) => spec.services.find((service) => service.name === 'web').args.at(spec.services.find((service) => service.name === 'web').args.indexOf('-p') + 1);
  assert.equal(portOf(calls[0]), '44010');
  assert.notEqual(portOf(calls[1]), '44010');
});
