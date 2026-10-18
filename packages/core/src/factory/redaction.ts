import { redactEnvValues } from "../sandbox/result-redaction.js";
/** Log payloads may include credentials unknown to the coordinator environment. */
export function redactFactoryOutput<T>(value: T): T {
  const clean = redactEnvValues(value, process.env);
  function visit(v: unknown): unknown {
    if (typeof v === "string")
      return v
        .replace(
          /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
          "[REDACTED:PRIVATE_KEY]",
        )
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
        .replace(
          /\b((?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*:\s*)[^\r\n]+/gi,
          "$1[REDACTED]",
        )
        .replace(
          /([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
          "$1[REDACTED]@",
        )
        .replace(
          /((?:[\w-]*(?:api[_-]?key|token|secret|password|passwd)|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,"'}]+)/gi,
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
