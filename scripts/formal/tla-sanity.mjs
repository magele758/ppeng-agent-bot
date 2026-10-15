/** Cheap structural validation, not a TLA parser or a proof. */
export function checkTla(name, source, cfg) {
  const errors = [];
  const text = source.replace(/\(\*[\s\S]*?\*\)/g, '').replace(/\\\*[^\n]*/g, '');
  const header = /^\s*-{4,}\s*MODULE\s+(\w+)\s*-{4,}/.exec(text);
  if (header?.[1] !== name) errors.push(`${name}: missing/mismatched module header`);
  if (!/^={4,}\s*$/m.test(text) || !/={4,}\s*$/.test(text)) errors.push(`${name}: missing module footer`);
  const definitions = new Set([...text.matchAll(/^\s*(\w+)\s*(?:\([^\n]*?\))?\s*==/gm)].map(m => m[1]));
  const refs = [...cfg.replace(/\\\*[^\n]*/g, '').matchAll(/^\s*(SPECIFICATION|INIT|NEXT|INVARIANT|PROPERTY)\s+(\w+)\s*$/gm)];
  if (!refs.some(m => m[1] === 'SPECIFICATION') && !refs.some(m => m[1] === 'INIT')) errors.push(`${name}: cfg needs SPECIFICATION or INIT`);
  for (const [, , ref] of refs) if (!definitions.has(ref)) errors.push(`${name}: cfg references undefined ${ref}`);
  return errors;
}
