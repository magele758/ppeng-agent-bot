import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { devNull } from "node:os";
import { randomUUID } from "node:crypto";
import { sanitizeScriptEnv } from "../spawn-utils.mjs";
const writers = new WeakSet(),
  leases = new WeakSet(),
  active = new Map();
function groupAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
/** Trusted local rehearsal code only, with subprocesses, workers and native addons denied.
 * This is not a production daemon or arbitrary process-tree coordinator. */
export class ManagedStateWriter {
  constructor({ stateDir, entrypoint, args = [] }) {
    if (
      !["darwin", "linux"].includes(process.platform) ||
      !isAbsolute(entrypoint) ||
      !lstatSync(entrypoint).isFile() ||
      lstatSync(entrypoint).isSymbolicLink() ||
      !Array.isArray(args) ||
      args.some((a) => typeof a !== "string")
    )
      throw Error("Fixed local Node entrypoint required");
    this.stateDir = realpathSync(stateDir);
    this.entrypoint = entrypoint;
    this.args = [...args];
    this.child = null;
    this.pending = false;
    this.groupGone = true;
    writers.add(this);
  }
  get running() {
    return Boolean(
      this.child &&
      !this.groupGone &&
      ((this.child.exitCode === null && this.child.signalCode === null) ||
        groupAlive(this.child.pid)),
    );
  }
  async start() {
    if (this.pending || existsSync(this.stateDir + ".recovery-lock"))
      throw Error("Recovery fenced or pending");
    if (active.has(this.stateDir)) throw Error("State writer already owned");
    active.set(this.stateDir, this);
    try {
      this.child = spawn(
        process.execPath,
        [
          "--permission",
          "--allow-fs-read=*",
          "--allow-fs-write=" + this.stateDir,
          this.entrypoint,
          ...this.args,
        ],
        {
          detached: true,
          env: sanitizeScriptEnv({
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            LANG: process.env.LANG,
            NODE_ENV: "test",
            DOTENV_CONFIG_PATH: devNull,
            RAW_AGENT_STATE_DIR: this.stateDir,
            RAW_AGENT_MODEL_PROVIDER: "heuristic",
            RAW_AGENT_SELF_HEAL_AUTO_START: "0",
            RAW_AGENT_E2E_ISOLATE: "1",
            RAW_AGENT_DAEMON_HOST: "127.0.0.1",
            RAW_AGENT_DAEMON_PORT: "0",
          }),
          cwd: this.stateDir,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      const child = this.child;
      this.groupGone = false;
      child.once("exit", () => {
        this.groupGone = !groupAlive(child.pid);
        if (this.groupGone && active.get(this.stateDir) === this)
          active.delete(this.stateDir);
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      return child.pid;
    } catch (e) {
      active.delete(this.stateDir);
      this.child = null;
      this.groupGone = true;
      throw e;
    }
  }
  async stop() {
    const child = this.child;
    if (!child) {
      if (active.get(this.stateDir) === this) active.delete(this.stateDir);
      return;
    }
    if (!this.groupGone && groupAlive(child.pid)) {
      process.kill(-child.pid, "SIGTERM");
      const end = Date.now() + 5000;
      while (!this.groupGone && groupAlive(child.pid) && Date.now() < end)
        await delay(10);
      if (!this.groupGone && groupAlive(child.pid))
        process.kill(-child.pid, "SIGKILL");
      const killed = Date.now() + 1000;
      while (!this.groupGone && groupAlive(child.pid) && Date.now() < killed)
        await delay(10);
      if (!this.groupGone && groupAlive(child.pid))
        throw Error("State writer process tree still alive");
    }
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("Writer exit unconfirmed")),
          1000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    if (child.connected) child.disconnect();
    this.child = null;
    this.groupGone = true;
    if (active.get(this.stateDir) === this) active.delete(this.stateDir);
  }
}
export function assertStateFence(lease, stateDir) {
  if (!leases.has(lease) || lease.stateDir !== realpathSync(stateDir))
    throw Error("Owned recovery fence required");
  lease.assertHeld();
}
export async function withQuiescedWriter(writer, operation) {
  if (!writers.has(writer) || typeof operation !== "function")
    throw Error("Owned native state writer required");
  const path = writer.stateDir + ".recovery-lock",
    nonce = randomUUID();
  let fd,
    db,
    lease,
    success = false;
  try {
    fd = openSync(path, "wx+", 0o600);
    writeFileSync(fd, nonce);
    if (active.has(writer.stateDir) && active.get(writer.stateDir) !== writer)
      throw Error("Another state writer owns this directory");
    await writer.stop();
    const file = writer.stateDir + "/runtime.sqlite";
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
      throw Error("Regular state database required");
    db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
    const rootIdentity = lstatSync(writer.stateDir),
      databaseIdentity = lstatSync(file);
    lease = {
      stateDir: writer.stateDir,
      assertHeld() {
        const actual = lstatSync(path),
          held = fstatSync(fd),
          rootNow = lstatSync(writer.stateDir),
          databaseNow = lstatSync(file);
        if (
          rootNow.ino !== rootIdentity.ino ||
          rootNow.dev !== rootIdentity.dev ||
          databaseNow.ino !== databaseIdentity.ino ||
          databaseNow.dev !== databaseIdentity.dev ||
          held.size !== Buffer.byteLength(nonce) ||
          (held.mode & 0o077) !== 0 ||
          held.uid !== process.getuid?.() ||
          writer.running ||
          !db.isTransaction ||
          actual.isSymbolicLink() ||
          actual.ino !== held.ino ||
          actual.dev !== held.dev ||
          (() => {
            const data = Buffer.alloc(Buffer.byteLength(nonce));
            return (
              readSync(fd, data, 0, data.length, 0) !== data.length ||
              data.toString("utf8") !== nonce
            );
          })()
        )
          throw Error("Recovery fence changed or writer resumed");
      },
    };
    leases.add(lease);
    lease.assertHeld();
    const result = await operation(lease);
    lease.assertHeld();
    success = true;
    return result;
  } finally {
    if (lease) leases.delete(lease);
    if (db) {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
    if (fd !== undefined) {
      // A changed/failed boundary remains pending and blocks restart; preserve its evidence.
      if (success) unlinkSync(path);
      else writer.pending = true;
      closeSync(fd);
    }
  }
}

/** Isolated rehearsal only. Production cutover requires a platform-specific writer boundary. */
export async function recoverIsolatedState({
  writer,
  backupDir,
  targetDir,
  expectedDigest,
  expectedCandidate,
  expectedContentFingerprint,
  activate,
  probe,
}) {
  try {
    if (
      !/^[a-f0-9]{64}$/.test(expectedContentFingerprint) ||
      typeof activate !== "function" ||
      typeof probe !== "function"
    )
      throw Error(
        "Verified state identity and fixed recovery actions required",
      );
    const { stateContentIdentity, restoreStateBackup } =
      await import("./state-backup.mjs");
    return await withQuiescedWriter(writer, async (lease) => {
      if (
        stateContentIdentity(writer.stateDir).fingerprint !==
        expectedContentFingerprint
      )
        throw Error("Durable state changed; preserve work and reconcile");
      const restored = await restoreStateBackup({
        backupDir,
        targetDir,
        expectedDigest,
        expectedCandidate,
        maxAgeMs: 3600000,
      });
      lease.assertHeld();
      if (
        stateContentIdentity(restored.targetDir).fingerprint !==
        expectedContentFingerprint
      )
        throw Error(
          "Restored snapshot is behind or incompatible with the frozen state",
        );
      if (
        stateContentIdentity(writer.stateDir).fingerprint !==
        expectedContentFingerprint
      )
        throw Error("State changed during recovery");
      const activated = await activate(restored.targetDir);
      lease.assertHeld();
      if (activated?.ok !== true || (await probe(restored.targetDir)) !== true)
        throw Error("Isolated recovery failed verification");
      return {
        ok: true,
        stage: "ISOLATED_RECOVERY_VERIFIED",
        productionRollbackAuthorized: false,
        cutoff: restored.cutoff,
      };
    });
  } catch {
    return {
      ok: false,
      stage: "RECOVERY_PENDING",
      productionRollbackAuthorized: false,
    };
  }
}
