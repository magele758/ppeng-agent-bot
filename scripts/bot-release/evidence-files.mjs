import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
  constants,
} from "node:fs";
import { resolve, join, sep } from "node:path";
import { homedir } from "node:os";
import { assessReleaseEvidence, REQUIRED_GATES } from "./evidence-contract.mjs";
export { REQUIRED_GATES };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function canonical(value, depth = 0) {
  if (depth > 32) throw Error("Invalid report depth");
  if (Array.isArray(value)) return value.map((v) => canonical(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k], depth + 1)]),
    );
  return value;
}
function signingBytes(report) {
  const { signature, ...body } = report;
  return JSON.stringify(canonical(body));
}
export function signEvidenceReport(report, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw Error("Trusted collector key required");
  return {
    ...report,
    signature: createHmac("sha256", key)
      .update("ppeng-release-evidence-v1\n" + signingBytes(report))
      .digest("hex"),
  };
}
/** Fixed owner-only host reference; manifest contents cannot select or replace the attestor. */
export function readTrustedEvidenceKey() {
  let fd;
  try {
    const path = join(
      homedir(),
      ".config",
      "ppeng-factory",
      "release",
      "attestation-credentials.json",
    );
    let walk = sep;
    for (const part of resolve(path).split(sep).filter(Boolean)) {
      walk = join(walk, part);
      if (lstatSync(walk).isSymbolicLink()) return undefined;
    }
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.mode & 0o077 ||
      st.uid !== process.getuid?.() ||
      st.size > 2048
    )
      return undefined;
    const bytes = Buffer.alloc(st.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length)
      return undefined;
    const value = JSON.parse(bytes.toString("utf8"));
    return typeof value.key === "string" && /^[a-f0-9]{64}$/.test(value.key)
      ? Buffer.from(value.key, "hex")
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function safeFile(root, path, maxBytes) {
  if (
    typeof path !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,240}$/.test(path) ||
    path
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /^(?:credentials|id_rsa|id_ed25519)(?:\.|$)/i.test(p),
      )
  )
    throw Error("Invalid evidence reference");
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw Error("Symbolic evidence reference");
  }
  const fd = openSync(
    current,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.size > maxBytes ||
      before.uid !== process.getuid?.()
    )
      throw Error("Invalid evidence file");
    const digest = createHash("sha256"),
      chunks = [];
    let offset = 0;
    while (offset < before.size) {
      const chunk = Buffer.alloc(Math.min(65536, before.size - offset)),
        size = readSync(fd, chunk, 0, chunk.length, offset);
      if (!size) throw Error("Incomplete evidence file");
      offset += size;
      digest.update(chunk.subarray(0, size));
      if (maxBytes <= 1048576) chunks.push(chunk.subarray(0, size));
    }
    const after = fstatSync(fd);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error("Evidence changed while reading");
    return {
      bytes: offset,
      sha256: digest.digest("hex"),
      data: maxBytes <= 1048576 ? Buffer.concat(chunks) : undefined,
    };
  } finally {
    closeSync(fd);
  }
}
function authentic(report, key) {
  if (
    !Buffer.isBuffer(key) ||
    key.length !== 32 ||
    typeof report.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.signature)
  )
    return false;
  const expected = signEvidenceReport(report, key).signature;
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(report.signature, "hex"),
  );
}
function bound(report, manifest, gate, now) {
  if (
    report.schemaVersion !== 1 ||
    report.collector !== "ppeng-release-runner-v1" ||
    report.gate !== gate ||
    report.status !== "passed"
  )
    return false;
  if (
    !["candidate", "environment", "protocolHash", "runtimeFingerprint"].every(
      (k) =>
        typeof manifest[k] === "string" &&
        manifest[k] &&
        report[k] === manifest[k],
    )
  )
    return false;
  if (
    !/^[a-f0-9]{40}$/.test(report.candidate) ||
    !["protocolHash", "runtimeFingerprint"].every((k) =>
      /^[a-f0-9]{64}$/.test(report[k]),
    )
  )
    return false;
  if (
    !["real", "controlled"].includes(report.mode) ||
    (["live-model", "live-software"].includes(gate) && report.mode !== "real")
  )
    return false;
  const start = Date.parse(report.startedAt),
    end = Date.parse(report.completedAt),
    until = Date.parse(report.validUntil);
  if (
    ![start, end, until].every(Number.isFinite) ||
    end < start ||
    end > now ||
    until <= now ||
    until > end + 604800000
  )
    return false;
  const metrics = report.measurements;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics))
    return false;
  if (gate === "soak" && end - start < (86400 + 1800) * 1000) return false;
  if (gate === "performance" && end - start < (900 + 300) * 1000) return false;
  return true;
}
function validMeasurements(gate, m) {
  const number = (name, min, max = Infinity) =>
    typeof m[name] === "number" &&
    Number.isFinite(m[name]) &&
    m[name] >= min &&
    m[name] <= max;
  const zeroLoss = () =>
    ["lostWork", "duplicateEffects", "unexplainedFailures"].every(
      (k) => m[k] === 0,
    );
  if (gate === "performance")
    return (
      m.fullProtocol === true &&
      m.referenceHardwareMatched === true &&
      m.dedicated === true &&
      m.ssdVerified === true &&
      number("cpuCores", 4, 4) &&
      number("memoryGiB", 8, 8) &&
      number("bots", 50, 50) &&
      number("historyRows", 1000000) &&
      m.precompressed === false &&
      number("clients", 20, 20) &&
      number("readRps", 40) &&
      number("topWorkRps", 2) &&
      number("warmupSeconds", 300) &&
      number("measurementSeconds", 900) &&
      ["pageP95Ms", "statusP95Ms", "receiveP95Ms"].every((k) =>
        number(k, 0, 500),
      ) &&
      number("searchP95Ms", 0, 1000) &&
      number("firstScreenP95Ms", 0, 2000) &&
      zeroLoss() &&
      number("drainSeconds", 0, 120)
    );
  if (gate === "soak")
    return (
      m.fullProtocol === true &&
      number("durationSeconds", 86400) &&
      number("warmupSeconds", 1800) &&
      m.continuous === true &&
      m.missingSamples === 0 &&
      number("hourlyBursts", 24) &&
      number("burstSeconds", 60) &&
      number("burstTopWorkRps", 20) &&
      number("halfHourWindows", 48) &&
      number("maxRssP95Ratio", 0, 1.2) &&
      number("maxConsecutiveWorseningQueueHours", 0, 2) &&
      zeroLoss() &&
      number("drainSeconds", 0, 120)
    );
  if (gate === "faults")
    return (
      number("sequences", 10000) &&
      Number.isSafeInteger(m.sequences) &&
      number("consecutivePasses", 3) &&
      m.killRestart === true &&
      zeroLoss() &&
      m.falseCompletions === 0
    );
  if (gate === "browser")
    return number("consecutivePasses", 3) && m.retries === 0;
  if (gate === "live-model") {
    if (!Array.isArray(m.models) || !m.models.length) return false;
    const ids = new Set();
    return (
      m.models.every((model) => {
        if (
          typeof model.id !== "string" ||
          !model.id ||
          ids.has(model.id) ||
          !Array.isArray(model.trials) ||
          model.trials.length < 3
        )
          return false;
        ids.add(model.id);
        return model.trials.every(
          (t) =>
            typeof t.turns === "number" &&
            t.turns >= 200 &&
            Number.isSafeInteger(t.turns) &&
            Number.isSafeInteger(t.compactions) &&
            t.compactions >= 12 &&
            Number.isSafeInteger(t.facts) &&
            t.facts >= 100 &&
            t.criticalRecall === 1 &&
            typeof t.otherRecall === "number" &&
            t.otherRecall >= 0.95 &&
            t.otherRecall <= 1,
        );
      }) &&
      number("trialsPerModel", 3) &&
      m.criticalRecall === 1 &&
      number("otherRecall", 0.95, 1)
    );
  }
  if (gate === "live-software")
    return (
      Array.isArray(m.connections) &&
      m.connections.length > 0 &&
      new Set(m.connections.map((c) => c.id)).size === m.connections.length &&
      m.connections.every(
        (c) =>
          typeof c.id === "string" &&
          c.id &&
          c.read === true &&
          c.write === true &&
          c.approval === true &&
          c.resultVerified === true,
      )
    );
  return true;
}
function verifyGate(manifest, gate, options, root) {
  const entries = manifest.checks.filter((c) => c?.gate === gate);
  if (entries.length !== 1) throw Error("Missing or duplicate gate");
  const entry = entries[0];
  if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))
    throw Error("Missing report digest");
  const source = safeFile(root, entry.artifact, 1048576);
  if (source.sha256 !== entry.sha256) throw Error("Report digest mismatch");
  const report = JSON.parse(source.data.toString("utf8"));
  if (
    !authentic(report, options.trustedKey) ||
    !bound(report, manifest, gate, options.now) ||
    !validMeasurements(gate, report.measurements)
  )
    throw Error("Untrusted or mismatched report");
  if (
    !Array.isArray(report.artifacts) ||
    !report.artifacts.length ||
    report.artifacts.length > 32
  )
    throw Error("Raw artifacts required");
  const paths = new Set();
  for (const artifact of report.artifacts) {
    if (
      !artifact ||
      paths.has(artifact.path) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0
    )
      throw Error("Invalid raw artifact");
    paths.add(artifact.path);
    const raw = safeFile(root, artifact.path, 67108864);
    if (raw.bytes !== artifact.bytes || raw.sha256 !== artifact.sha256)
      throw Error("Raw artifact mismatch");
  }
  return {
    ...report.measurements,
    gate,
    candidate: manifest.candidate,
    status: "passed",
    artifact: entry.artifact,
  };
}
/** Verify bytes and trusted collector origin before interpreting thresholds. No file is executed or fetched. */
export function verifyReleaseEvidence(
  manifest,
  { root, trustedKey, now = Date.now() } = {},
) {
  const candidate =
    typeof manifest?.candidate === "string" &&
    /^[a-f0-9]{40}$/.test(manifest.candidate)
      ? manifest.candidate
      : null;
  const missing = [],
    invalid = [],
    checks = [];
  let directory;
  try {
    if (!root || lstatSync(root).isSymbolicLink())
      throw Error("Evidence root required");
    directory = realpathSync(root);
  } catch {
    return {
      candidate,
      ready: false,
      missing: [...REQUIRED_GATES],
      invalid: [{ gate: "all", reason: "evidence-root-unavailable" }],
      authoritative: false,
    };
  }
  if (
    !manifest ||
    !Array.isArray(manifest.checks) ||
    manifest.checks.length > 100 ||
    !Number.isFinite(now)
  )
    return {
      candidate: null,
      ready: false,
      missing: [...REQUIRED_GATES],
      invalid: [{ gate: "all", reason: "invalid-manifest" }],
      authoritative: false,
    };
  for (const gate of REQUIRED_GATES) {
    try {
      checks.push(verifyGate(manifest, gate, { trustedKey, now }, directory));
    } catch {
      missing.push(gate);
      invalid.push({ gate, reason: "evidence-unverified" });
    }
  }
  const contract = assessReleaseEvidence({
    candidate: manifest.candidate,
    checks,
  });
  for (const gate of contract.missing)
    if (!missing.includes(gate)) missing.push(gate);
  return {
    candidate,
    ready: false,
    artifactChecksPassed: missing.length === 0,
    blockers: [
      "trusted-collector-integration-pending",
      "stage4-environment-evidence-pending",
    ],
    missing,
    invalid,
    authoritative: false,
    verified: checks.map((c) => c.gate),
  };
}
