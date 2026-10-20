/** Pure helpers for npm publish. No registry calls. */
import { join, resolve } from "node:path";

export const SCOPE_FROM = "@ppeng/";
export const SCOPE_TO = "@mage-ai-lab/";
export const PUBLIC_NPM_NAMES = ["@mage-ai-lab/api-types", "@mage-ai-lab/agent-loop"];
export const PUBLIC_VERSION_FILES = [
  "packages/api-types/package.json",
  "packages/agent-loop/package.json",
  "packages/core/package.json",
  "apps/web-console/package.json",
];
const NPM_TOKEN_ENV_KEYS = [
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_AUTH_TOKEN",
  "NPM_CONFIG__AUTH",
  "npm_config__auth",
];
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function rewriteScope(text) {
  return text.split(SCOPE_FROM).join(SCOPE_TO);
}

/**
 * Version required by the current Git ref.
 * Push, PR, and non-npm tags return null (publish is not gated).
 * Tag `npm-v<version>` returns that version.
 */
export function versionRequiredByRef(refType, refName) {
  if (refType !== "tag") return null;
  const tag = refName ?? "";
  if (!tag.startsWith("npm-v")) return null;
  const expected = tag.slice("npm-v".length);
  return expected || null;
}

/** Null when the tag matches every package version. */
export function tagMismatchMessage(expected, versions) {
  if (expected == null) return null;
  for (const [name, version] of Object.entries(versions)) {
    if (version !== expected) {
      return `tag npm-v${expected} does not match packages/${name} version ${version}`;
    }
  }
  return null;
}

function parseStable(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Refusing unexpected package version: ${version}`);
  return match.slice(1).map(Number);
}

export function compareSemver(left, right) {
  const a = parseStable(left);
  const b = parseStable(right);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function bumpSemver(version, versionType) {
  const [major, minor, patch] = parseStable(version);
  if (versionType === "major") return `${major + 1}.0.0`;
  if (versionType === "minor") return `${major}.${minor + 1}.0`;
  if (versionType === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unsupported version_type: ${versionType}`);
}

/** Next version for the two public packages. Registry 0.0.0 means the package is absent. */
export function planPublicRelease({ versionType, repoVersions, registryVersions }) {
  for (const name of ["api-types", "agent-loop"]) {
    parseStable(repoVersions[name]);
  }
  if (versionType === "republish") {
    if (repoVersions["api-types"] !== repoVersions["agent-loop"]) {
      throw new Error("api-types and agent-loop versions differ; align them before republish");
    }
    return { version: repoVersions["api-types"], bump: false };
  }
  if (versionType !== "patch" && versionType !== "minor" && versionType !== "major") {
    throw new Error(`unsupported version_type: ${versionType}`);
  }
  const bases = ["api-types", "agent-loop"].map((name) => repoVersions[name]);
  for (const value of registryVersions ?? []) {
    const core = String(value ?? "").trim().split("-")[0];
    if (core === "" || core === "0.0.0") continue;
    parseStable(core);
    bases.push(core);
  }
  const base = bases.reduce((best, cur) => (compareSemver(cur, best) > 0 ? cur : best));
  return { version: bumpSemver(base, versionType), bump: true };
}

const DEPENDENCY_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

export function rewritePublicVersionPins(value, nextVersion) {
  parseStable(nextVersion);
  const names = new Set(PUBLIC_NPM_NAMES.map((name) => name.replace("@mage-ai-lab/", "@ppeng/")).concat(PUBLIC_NPM_NAMES));
  function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, child] of Object.entries(node)) {
      if (DEPENDENCY_KEYS.includes(key) && child && typeof child === "object" && !Array.isArray(child)) {
        out[key] = {};
        for (const [dep, spec] of Object.entries(child)) {
          out[key][dep] = names.has(dep) && /^\d+\.\d+\.\d+$/.test(spec) ? nextVersion : spec;
        }
      } else {
        out[key] = walk(child);
      }
    }
    if (names.has(out.name) && /^\d+\.\d+\.\d+$/.test(out.version)) out.version = nextVersion;
    return out;
  }
  return walk(value);
}

/** `npm-v1.2.3` or `npm-v1.2.3-beta.1`. Branch names and desktop `v*` tags are not included. */
export function isNpmPublishTag(name) {
  return typeof name === "string" && /^npm-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(name);
}

export function shouldPublishNpm({ eventName, prerelease, tagName, refType, refName }) {
  if (eventName === "workflow_dispatch") return true;
  if (eventName === "push") return refType === "tag" && isNpmPublishTag(refName);
  if (eventName !== "release") return false;
  if (prerelease === true || prerelease === "true") return false;
  return isNpmPublishTag(tagName);
}

export function publishAuthMode(env) {
  return env.GITHUB_ACTIONS === "true" ? "oidc" : "local";
}

export function withoutNpmTokens(env) {
  const next = { ...env };
  for (const key of NPM_TOKEN_ENV_KEYS) delete next[key];
  return next;
}

export function npmSupportsOidc(version) {
  const parts = String(version).trim().split(".").map((part) => Number(part));
  const [major, minor, patch] = parts;
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major > 11) return true;
  if (major < 11) return false;
  if (minor > 5) return true;
  if (minor < 5) return false;
  return (patch || 0) >= 1;
}

export function distTagForVersion(version) {
  if (!VERSION_RE.test(version)) throw new Error(`Refusing unexpected package version: ${version}`);
  const hyphen = version.indexOf("-");
  if (hyphen === -1) return "latest";
  const tag = version.slice(hyphen + 1).split(".")[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(tag) || tag === "latest") {
    throw new Error(`Refusing dist-tag for prerelease version ${version}`);
  }
  return tag;
}

export function assertPublishablePackage({ name, version, private: isPrivate }) {
  if (isPrivate === true) throw new Error("Refusing to publish a private package.");
  if (!PUBLIC_NPM_NAMES.includes(name)) throw new Error(`Refusing to publish ${name}; not in the public allowlist.`);
  return { name, version, tag: distTagForVersion(version) };
}

export function stripEmptyNpmAuth(contents) {
  if (typeof contents !== "string" || contents.length === 0) return contents;
  return contents
    .split("\n")
    .filter((line) => !/_authToken=\$\{NODE_AUTH_TOKEN\}/.test(line))
    .filter((line) => !/_authToken=\s*$/.test(line))
    .join("\n");
}

export function npmrcCandidates(env, cwd) {
  const paths = [];
  const home = env.HOME || env.USERPROFILE;
  if (home) paths.push(join(home, ".npmrc"));
  if (cwd) paths.push(join(cwd, ".npmrc"));
  if (env.RUNNER_TEMP) paths.push(join(env.RUNNER_TEMP, ".npmrc"));
  if (env.GITHUB_WORKSPACE) paths.push(join(env.GITHUB_WORKSPACE, ".npmrc"));
  if (env.NPM_CONFIG_USERCONFIG) paths.push(env.NPM_CONFIG_USERCONFIG);
  return paths;
}

export function buildPublishArgs(tarballPath, tag, { provenance = false, dryRun = false } = {}) {
  const args = [
    "publish",
    resolve(tarballPath),
    "--ignore-scripts",
    "--access",
    "public",
    "--tag",
    tag,
    "--registry",
    "https://registry.npmjs.org/",
  ];
  if (provenance) args.push("--provenance");
  if (dryRun) args.push("--dry-run");
  return args;
}

export function emptyPublishAction(pendingCount, ifExists) {
  if (pendingCount > 0) return "publish";
  if (ifExists === "skip") return "ok";
  return "fail";
}

export function publishFailureMessage() {
  return "npm publish failed. Configure npm Trusted Publisher for workflow publish-npm.yml on @mage-ai-lab/api-types and @mage-ai-lab/agent-loop.";
}
