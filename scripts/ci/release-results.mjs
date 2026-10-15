import { pathToFileURL } from 'node:url';
export function releaseFailures(needs) {
  const optional = new Set(['remote-model-smoke', 'harness', 'compact-ab']);
  const required = ['tests', 'crap', 'acceptance', 'mutation', 'secrets-gate'];
  return [...new Set([...required, ...Object.keys(needs)])].filter(name => {
    const result = needs[name]?.result;
    return result !== 'success' && !(optional.has(name) && result === 'skipped');
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = releaseFailures(JSON.parse(process.argv[2]));
  console.log(failures.length ? `Release gate failed: ${failures.join(', ')}` : 'All required and participating optional checks passed');
  process.exitCode = failures.length ? 1 : 0;
}
