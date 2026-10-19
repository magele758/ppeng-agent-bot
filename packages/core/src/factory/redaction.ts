import { redactEnvValues } from "../sandbox/result-redaction.js";
/** Scan markers once, including truncated PEMs, rather than retrying an unterminated
 * key body from every BEGIN marker in a large tool result. */
function redactPrivateKeys(input: string): string {
  const markers = /-----(BEGIN|END) [^-]*PRIVATE KEY-----/g;
  const chunks: string[] = [];
  let start = -1, consumed = 0;
  for (let match = markers.exec(input); match; match = markers.exec(input)) {
    if (match[1] === "BEGIN" && start < 0) start = match.index;
    if (match[1] === "END" && start >= 0) {
      chunks.push(input.slice(consumed, start), "[REDACTED:PRIVATE_KEY]");
      consumed = markers.lastIndex;
      start = -1;
    }
  }
  chunks.push(start >= 0 ? input.slice(consumed, start) + "[REDACTED:PRIVATE_KEY]" : input.slice(consumed));
  return chunks.join("");
}
/** Log payloads may include credentials unknown to the coordinator environment. */
export function redactFactoryOutput<T>(value: T): T {
  const clean = redactEnvValues(value, process.env);
  function visit(v: unknown): unknown {
    if (typeof v === "string")
      return redactPrivateKeys(v)
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
        .replace(
          /\b((?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*:\s*)[^\r\n]+/gi,
          "$1[REDACTED]",
        )
        .replace(
          /(?<![a-z\d+.-])([a-z\d+.-]+:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
          "$1[REDACTED]@",
        )
        .replace(
          /(?<![\w-])([\w-]*(?:api[_-]?key|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,"'}]+)/gi,
          "$1[REDACTED]",
        );
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          /(?:api[_-]?key|token|secret|password|passwd|authorization|cookie)/i.test(
            k,
          )
            ? "[REDACTED]"
            : visit(x),
        ]),
      );
    return v;
  }
  return visit(clean) as T;
}
