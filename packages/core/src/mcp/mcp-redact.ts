/** Values shorter than this are not replaced; they match ordinary words. */
const MIN_SECRET_LENGTH = 8;

/** Exact secret plus percent-encoded and JSON-escaped spellings. */
function secretForms(secret: string): string[] {
  const encoded = encodeURIComponent(secret);
  const json = JSON.stringify(secret).slice(1, -1);
  const forms = new Set<string>([secret]);
  if (encoded !== secret) {
    forms.add(encoded);
    forms.add(encoded.toLowerCase());
  }
  if (json !== secret) forms.add(json);
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Replace credential text, including percent-encoded and JSON-escaped copies. */
export function redactSecrets(text: string, secrets: string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length
  );
  let out = text;
  for (const secret of unique) {
    for (const form of secretForms(secret)) out = out.split(form).join('[REDACTED]');
  }
  return out;
}
