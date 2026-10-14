import { mock } from 'node:test';
import { EventEmitter } from 'node:events';

const attempts = [];
function request(url, options = {}) {
  attempts.push({
    href: url instanceof URL ? url.href : String(url),
    method: options.method ?? 'GET'
  });
  const req = new EventEmitter();
  req.end = () => {
    queueMicrotask(() => req.emit('error', new Error('unexpected egress')));
  };
  return req;
}

mock.module('node:http', { namedExports: { request } });
mock.module('node:https', { namedExports: { request } });
mock.module('node:dns/promises', {
  namedExports: {
    lookup: async (host) => {
      if (host === 'cgnat.example') return [{ address: '100.100.100.200', family: 4 }];
      if (host === 'mixed.example') return [{ address: '1.1.1.1', family: 4 }, { address: '100.64.0.1', family: 4 }];
      return [{ address: '8.8.8.8', family: 4 }];
    }
  }
});

// mock.module only applies to imports that happen after it is installed.
const { SoftwareExecution } = await import('../../dist/connectors/software-execution.js');

const cases = JSON.parse(process.argv[2] ?? '[]');
const map = new Map();
const store = {
  getDaemonControl: (key) => structuredClone(map.get(key)),
  setDaemonControl: (key, value) => map.set(key, structuredClone(value))
};
const results = [];
for (const item of cases) {
  const before = attempts.length;
  const execution = new SoftwareExecution(store, {});
  const principal = execution.principal({ userId: 'u' });
  const name = `egress_${item.id}`;
  execution.bind(principal, 'bot-a', item.id, {
    tools: [{
      name,
      description: 'egress probe',
      inputSchema: { type: 'object' },
      executor: { kind: 'http', url: item.url, method: item.method, timeoutMs: 200 }
    }]
  });
  const result = await execution.execute(
    { session: { id: 's', metadata: { botId: 'bot-a', userId: 'u' } }, agent: { id: 'general' } },
    name,
    {}
  );
  results.push({
    id: item.id,
    attempts: attempts.length - before,
    ok: result.ok,
    content: result.content
  });
}
process.stdout.write(JSON.stringify(results));
