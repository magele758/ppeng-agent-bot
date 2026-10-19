import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { FACTORY_WORKER } from "../dist/factory/transport.js";
import {
  GIT_DISCOVERY_WORKER,
  listGitCheckouts,
} from "../dist/factory/discover.js";
import { sanitizeSpawnEnv } from "../dist/sandbox/env-sanitizer.js";

const SENTINEL = "SUPER-SECRET-PRIVATE-KEY";

function gitEnv() {
  return {
    ...sanitizeSpawnEnv({ stripCredentials: true }),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Factory Test",
    GIT_AUTHOR_EMAIL: "factory@example.test",
    GIT_COMMITTER_NAME: "Factory Test",
    GIT_COMMITTER_EMAIL: "factory@example.test",
  };
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: gitEnv() });
}

function commitFile(dir, name, body) {
  writeFileSync(join(dir, name), body);
  execFileSync("git", ["add", "--", name], { cwd: dir, env: gitEnv() });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir, env: gitEnv() });
}

function restore(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function useSsh(t, home) {
  const root = mkdtempSync(join(tmpdir(), "factory-discover-ssh-"));
  const bin = join(root, "bin");
  const capture = join(root, "capture.json");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "ssh"),
    readFileSync(new URL("./factory-discover-ssh.cjs", import.meta.url)),
  );
  chmodSync(join(bin, "ssh"), 0o755);
  const previous = {
    PATH: process.env.PATH,
    RAW_AGENT_AUTH_TOKEN: process.env.RAW_AGENT_AUTH_TOKEN,
    CAPTURE: process.env.CAPTURE,
    DISCOVERY_HOME: process.env.DISCOVERY_HOME,
  };
  process.env.PATH = bin + delimiter + (previous.PATH ?? "");
  process.env.RAW_AGENT_AUTH_TOKEN = "daemon-token-should-not-leak";
  process.env.CAPTURE = capture;
  process.env.DISCOVERY_HOME = home;
  t.after(() => {
    restore("PATH", previous.PATH);
    restore("RAW_AGENT_AUTH_TOKEN", previous.RAW_AGENT_AUTH_TOKEN);
    restore("CAPTURE", previous.CAPTURE);
    restore("DISCOVERY_HOME", previous.DISCOVERY_HOME);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    capture,
    read() {
      return JSON.parse(readFileSync(capture, "utf8"));
    },
  };
}

function plantKey(dir) {
  mkdirSync(dir, { recursive: true });
  const key = join(dir, "id_rsa");
  writeFileSync(key, SENTINEL);
  chmodSync(key, 0o000);
  return key;
}

test("probe still returns only remote identity", () => {
  const result = spawnSync("python3", ["-I", "-c", FACTORY_WORKER], {
    input: JSON.stringify({ action: "probe" }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ["hostname", "identity"]);
  assert.equal(typeof parsed.identity, "string");
  assert.equal(parsed.identity.length > 0, true);
  assert.equal(typeof parsed.hostname, "string");
  assert.equal(FACTORY_WORKER.includes("list-checkouts"), false);
  assert.match(FACTORY_WORKER, /not in \('snapshot','count-files','read-log'\)/);
});

test("lists absolute git checkouts under the given roots [AC:superbot-factory-setup#AC-3]", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "factory-discover-roots-"));
  const realHome = realpath(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ssh = useSsh(t, realHome);
  const wanted = join(realHome, "wanted");
  const main = join(wanted, "main");
  const nested = join(main, "nested");
  const worktree = join(wanted, "my repo");
  const bare = join(wanted, "bare.git");
  const decoy = join(realHome, "decoy");
  initRepo(main);
  commitFile(main, "readme", "main\n");
  execFileSync("git", ["worktree", "add", "--detach", "-q", worktree], {
    cwd: main,
    env: gitEnv(),
  });
  initRepo(nested);
  commitFile(nested, "inside", "nested\n");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: gitEnv() });
  mkdirSync(join(wanted, "notes"));
  writeFileSync(join(wanted, "notes", "plain.txt"), "not a checkout\n");
  plantKey(join(wanted, ".ssh"));
  initRepo(join(wanted, ".ssh", "hidden"));
  initRepo(decoy);
  commitFile(decoy, "nope", "outside the root\n");

  const paths = await listGitCheckouts("factorybox", [wanted]);
  const expected = [main, nested, worktree].sort();
  assert.deepEqual(paths, expected);
  assert.equal(paths.includes(decoy), false);
  assert.equal(paths.includes(join(wanted, ".ssh", "hidden")), false);
  assert.equal(paths.includes(bare), false);
  assert.equal(paths.every((path) => path.startsWith("/")), true);

  const wire = ssh.read();
  assert.equal(JSON.parse(wire.input).action, "list-checkouts");
  assert.deepEqual(JSON.parse(wire.input).roots, [wanted]);
  assert.equal(wire.pythonStdout.includes(SENTINEL), false);
  assert.equal(wire.pythonStderr.includes(SENTINEL), false);
});

test("a single home checkout is only a path list [AC:superbot-factory-setup#AC-3]", async (t) => {
  const home = realpath(mkdtempSync(join(tmpdir(), "factory-discover-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ssh = useSsh(t, home);
  const repo = join(home, "only");
  initRepo(repo);
  commitFile(repo, "readme", "only\n");
  const marker = join(home, "settings.json");
  writeFileSync(marker, "{\"repositories\":[]}\n");

  const paths = await listGitCheckouts("factorybox");

  assert.ok(Array.isArray(paths));
  assert.deepEqual(paths, [repo]);
  assert.equal("roots" in JSON.parse(ssh.read().input), false);
  assert.equal(JSON.parse(ssh.read().input).action, "list-checkouts");
  assert.equal(readFileSync(marker, "utf8"), "{\"repositories\":[]}\n");
  assert.equal(existsSync(join(home, ".local", "state", "ppeng-factory")), false);
});

test("an empty root list discovers nothing [AC:superbot-factory-setup#AC-3]", async (t) => {
  const home = realpath(mkdtempSync(join(tmpdir(), "factory-discover-empty-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ssh = useSsh(t, home);
  const repo = join(home, "only");
  initRepo(repo);
  commitFile(repo, "readme", "only\n");

  const paths = await listGitCheckouts("factorybox", []);

  assert.deepEqual(paths, []);
  assert.equal("roots" in JSON.parse(ssh.read().input), true);
  assert.deepEqual(JSON.parse(ssh.read().input).roots, []);
});

test("discovery ssh stays on the fixed program without token, keys, or intranet fetch [AC:superbot-factory-setup#AC-11]", async (t) => {
  const home = realpath(mkdtempSync(join(tmpdir(), "factory-discover-guard-")));
  const canary = join(home, "canary");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ssh = useSsh(t, home);
  const app = join(home, "app");
  initRepo(app);
  commitFile(app, "readme", "app\n");
  plantKey(join(home, ".ssh"));
  initRepo(join(home, ".ssh", "hidden"));
  const source = readFileSync(new URL("../dist/factory/discover.js", import.meta.url), "utf8");
  for (const banned of ["web_fetch", "web-fetch", "saveSettings", "node:fs", "readFile"]) {
    assert.equal(source.includes(banned), false, banned);
  }
  for (const banned of ["web_fetch", "urllib", "http.client", "subprocess", "os.system", "socket", "read_text", "read_bytes"]) {
    assert.equal(GIT_DISCOVERY_WORKER.includes(banned), false, banned);
  }
  assert.equal(GIT_DISCOVERY_WORKER.match(/git\.open\(/g)?.length, 1);

  await assert.rejects(
    listGitCheckouts("factorybox", ["http://10.0.0.1/repo"]),
    /Invalid checkout root/,
  );
  await assert.rejects(
    listGitCheckouts("factorybox", [join(home, ".ssh")]),
    /Invalid checkout root/,
  );
  await assert.rejects(
    listGitCheckouts("factorybox", ["repo;rm -rf /"]),
    /Invalid checkout root/,
  );
  await assert.rejects(listGitCheckouts("bad alias"), /Invalid SSH alias/);
  assert.equal(existsSync(ssh.capture), false);
  assert.equal(existsSync(canary), false);

  const sneaky = `${app};touch ${canary}`;
  const paths = await listGitCheckouts("factorybox", [home, sneaky]);
  assert.deepEqual(paths, [app]);
  assert.equal(existsSync(canary), false);
  assert.equal(paths.includes(join(home, ".ssh", "hidden")), false);

  const wire = ssh.read();
  assert.equal(wire.hasAuthToken, false);
  assert.equal(wire.authToken, null);
  assert.equal(wire.hasIdentityFlag, false);
  assert.equal(wire.commandOk, true);
  assert.equal(wire.program, GIT_DISCOVERY_WORKER);
  assert.equal(wire.pythonStdout.includes(SENTINEL), false);
  assert.equal(wire.pythonStderr.includes(SENTINEL), false);
  assert.equal(JSON.parse(wire.input).action, "list-checkouts");
  assert.deepEqual(JSON.parse(wire.input).roots, [home, sneaky]);
  assertFixedSsh(wire.argv, "factorybox");
  const command = wire.argv.at(-1);
  assert.equal(command.includes(home), false);
  assert.equal(command.includes("touch"), false);
  assert.equal(command.includes("curl"), false);
  assert.equal(command.includes("web_fetch"), false);
  assert.equal(command.includes(SENTINEL), false);
  assert.equal(command.includes("10.0.0.1"), false);
});

function assertFixedSsh(argv, alias) {
  assert.deepEqual(argv, [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
    "--",
    alias,
    argv.at(-1),
  ]);
  assert.match(argv.at(-1), /^python3 -I -c "import base64;exec\(base64\.b64decode\('[A-Za-z0-9+/=]+'\)\)"$/);
}

function realpath(path) {
  return realpathSync(path);
}


test("discovery refuses a unique-looking result when the depth budget hides another checkout", async (t) => {
  const home=realpath(mkdtempSync(join(tmpdir(),'factory-discover-depth-')));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const ssh=useSsh(t,home);
  initRepo(join(home,'visible'));
  initRepo(join(home,...Array.from({length:18},(_,i)=>'deep'+i),'hidden'));
  await assert.rejects(listGitCheckouts('factorybox',[home]),/discovery was incomplete/);
  const receipt=JSON.parse(ssh.read().pythonStdout);
  assert.equal(receipt.complete,false);
  assert.deepEqual(receipt.paths,[join(home,'visible')]);
});
