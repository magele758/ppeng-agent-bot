import { assertStateFence } from "./state-fence.mjs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  chmodSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
const MAX_FILES = 10000,
  MAX_BYTES = 16 * 1024 ** 3;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function within(parent, child) {
  return child === parent || child.startsWith(parent + sep);
}
function rootPath(path) {
  const root = realpathSync(path),
    st = lstatSync(root);
  if (!st.isDirectory() || st.uid !== process.getuid?.())
    throw Error("Owned state directory required");
  return root;
}
function newTarget(path, excluded) {
  const result = join(
    rootPath(dirname(resolve(path))),
    resolve(path).split(sep).at(-1),
  );
  if (
    existsSync(result) ||
    excluded.some((root) => within(root, result) || within(result, root))
  )
    throw Error("New isolated destination required");
  return result;
}
function scan(root) {
  const files = [];
  let total = 0;
  function walk(folder) {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name),
        rel = relative(root, path).split(sep).join("/"),
        st = lstatSync(path);
      if (st.isSymbolicLink() || st.uid !== process.getuid?.())
        throw Error("Unsafe state entry");
      if (st.isDirectory()) walk(path);
      else if (!st.isFile()) throw Error("Regular state files required");
      else {
        if (["runtime.sqlite-shm", "backup-manifest.json"].includes(rel))
          continue;
        total += st.size;
        if (files.length >= MAX_FILES || total > MAX_BYTES)
          throw Error("Backup resource limit exceeded");
        files.push({ path: rel, bytes: st.size });
      }
    }
  }
  walk(root);
  return files;
}
function readStable(root, entry, target) {
  const fd = openSync(
    join(root, entry.path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let out;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size !== entry.bytes)
      throw Error("State changed during backup");
    if (target) {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      out = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    }
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < before.size) {
      const b = Buffer.alloc(Math.min(65536, before.size - offset)),
        n = readSync(fd, b, 0, b.length, offset);
      if (!n) throw Error("Incomplete state file");
      hash.update(b.subarray(0, n));
      if (out !== undefined) {
        let written = 0;
        while (written < n) {
          const size = writeSync(out, b, written, n - written);
          if (!size) throw Error("Incomplete backup write");
          written += size;
        }
      }
      offset += n;
    }
    const after = fstatSync(fd);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error("State changed during backup");
    return { ...entry, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
    if (out !== undefined) closeSync(out);
  }
}
function checkDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare("PRAGMA quick_check").all()[0]?.quick_check !== "ok")
      throw Error("Database integrity failed");
  } finally {
    db.close();
  }
}
/** Host-side primitive. Locks SQLite writes and verifies attached files remained static.
 * An online snapshot does not prove external writers were quiesced or authorize production rollback. */
export async function createStateBackup({
  stateDir,
  backupDir,
  candidate,
  now,
  fence,
}) {
  if (
    !/^[a-f0-9]{40}$/.test(candidate) ||
    (now !== undefined && !Number.isFinite(now))
  )
    throw Error("Exact candidate and cutoff required");
  const source = rootPath(stateDir),
    target = newTarget(backupDir, [source]);
  let guard,
    created = false;
  try {
    mkdirSync(target, { mode: 0o700 });
    created = true;
    const initial = scan(source);
    if (!initial.some((f) => f.path === "runtime.sqlite"))
      throw Error("State database required");
    if (fence) assertStateFence(fence, source);
    else {
      guard = new DatabaseSync(join(source, "runtime.sqlite"));
      guard.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
    }
    const cutoff = now ?? Date.now();
    const before = scan(source);
    if (!before.some((f) => f.path === "runtime.sqlite"))
      throw Error("State database required");
    // Keep the original DB and WAL bytes under a SQLite write reservation. This
    // preserves implicit rowids and avoids native asynchronous backup lifetime/GC coupling.
    const copied = before.map((f) =>
      readStable(source, f, join(target, f.path)),
    );
    const after = scan(source);
    if (
      JSON.stringify(after) !== JSON.stringify(before) ||
      after.some((f, i) => readStable(source, f).sha256 !== copied[i].sha256)
    )
      throw Error("State files changed during backup");
    checkDatabase(join(target, "runtime.sqlite"));
    const files = scan(target).map((f) => readStable(target, f));
    const manifest = {
      schemaVersion: 1,
      candidate,
      cutoff: new Date(cutoff).toISOString(),
      mode: "sqlite-locked-files",
      purpose: "isolated-restore-only",
      files,
    };
    const bytes = JSON.stringify(manifest);
    writeFileSync(join(target, "backup-manifest.json"), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    return {
      digest: digest(bytes),
      candidate,
      cutoff: manifest.cutoff,
      backupDir: target,
      productionRollbackAuthorized: false,
    };
  } catch (error) {
    if (created) rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    if (guard) {
      if (guard.isTransaction) guard.exec("ROLLBACK");
      guard.close();
    }
  }
}
export async function restoreStateBackup({
  backupDir,
  targetDir,
  expectedDigest,
  expectedCandidate,
  maxAgeMs,
  now = Date.now(),
}) {
  const started = performance.now(),
    source = rootPath(backupDir),
    target = newTarget(targetDir, [source]);
  if (
    !/^[a-f0-9]{64}$/.test(expectedDigest) ||
    !Number.isFinite(now) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0
  )
    throw Error("Trusted backup identity and age bound required");
  const manifestPath = join(source, "backup-manifest.json"),
    st = lstatSync(manifestPath);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 2 * 1024 * 1024)
    throw Error("Invalid backup manifest");
  const bytes = readFileSync(manifestPath);
  if (digest(bytes) !== expectedDigest) throw Error("Backup manifest changed");
  const manifest = JSON.parse(bytes.toString("utf8")),
    cutoff = Date.parse(manifest.cutoff);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.mode !== "sqlite-locked-files" ||
    !/^[a-f0-9]{40}$/.test(expectedCandidate) ||
    manifest.purpose !== "isolated-restore-only" ||
    manifest.candidate !== expectedCandidate ||
    !Number.isFinite(cutoff) ||
    cutoff > now ||
    now - cutoff > maxAgeMs
  )
    throw Error("Backup identity or cutoff mismatch");
  const observed = scan(source);
  if (
    !Array.isArray(manifest.files) ||
    observed.length !== manifest.files.length
  )
    throw Error("Backup inventory mismatch");
  const files = observed.map((f) => readStable(source, f));
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw Error("Backup content mismatch");
  let created = false;
  try {
    mkdirSync(target, { mode: 0o700 });
    created = true;
    for (const f of files)
      if (readStable(source, f, join(target, f.path)).sha256 !== f.sha256)
        throw Error("Backup changed during restore");
    checkDatabase(join(target, "runtime.sqlite"));
    const elapsedMs = performance.now() - started;
    if (elapsedMs > 900000)
      throw Error("Isolated restore exceeded fifteen minutes");
    return {
      ok: true,
      targetDir: target,
      cutoff: manifest.cutoff,
      digest: expectedDigest,
      elapsedMs,
      productionRollbackAuthorized: false,
    };
  } catch (error) {
    if (created) rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

/** Content identity is deliberately stricter than schema compatibility. Any durable change
 * forbids image-only rollback, preserving accepted work rather than restoring an old snapshot. */
export function stateContentIdentity(stateDir) {
  const root = rootPath(stateDir),
    inventory = scan(root),
    hash = createHash("sha256");
  if (!inventory.some((f) => f.path === "runtime.sqlite"))
    throw Error("State database required");
  const db = new DatabaseSync(join(root, "runtime.sqlite"), { readOnly: true });
  const encode = (value) =>
    typeof value === "bigint"
      ? ["integer", String(value)]
      : value instanceof Uint8Array
        ? ["blob", Buffer.from(value).toString("hex")]
        : value === null
          ? ["null"]
          : [typeof value, value];
  const ident = (value) => '"' + value.replaceAll('"', '""') + '"';
  let rows = 0,
    bytes = 0;
  try {
    db.exec("BEGIN");
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name",
      )
      .all();
    hash.update(JSON.stringify(schema));
    for (const pragma of ["user_version", "application_id", "encoding"])
      hash.update(JSON.stringify(db.prepare("PRAGMA " + pragma).all()));
    const tables = schema.filter((entry) => entry.type === "table");
    const tableKinds = db.prepare("PRAGMA table_list").all();
    for (const table of tables) {
      hash.update(JSON.stringify(table));
      const tableColumns = db
        .prepare("PRAGMA table_xinfo(" + ident(table.name) + ")")
        .all();
      const columns = tableColumns
        .filter((c) => c.hidden === 0)
        .map((c) => c.name);
      if (!columns.length) continue;
      const metadata = tableKinds.find(
        (entry) => entry.schema === "main" && entry.name === table.name,
      );
      if (!metadata) throw Error("Unknown table rowid format");
      if (!metadata.wr) {
        const names = new Set(
          tableColumns.map((column) => column.name.toLowerCase()),
        );
        const rowid = ["rowid", "_rowid_", "oid"].find(
          (name) => !names.has(name),
        );
        if (!rowid) throw Error("Implicit rowid is inaccessible");
        columns.unshift(rowid);
      }
      const stmt = db.prepare(
        "SELECT " +
          columns.map(ident).join(",") +
          " FROM " +
          ident(table.name) +
          " ORDER BY " +
          columns.map(ident).join(","),
      );
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      for (const row of stmt.iterate()) {
        const data = JSON.stringify(row.map(encode));
        bytes += Buffer.byteLength(data);
        rows++;
        if (rows > 10000000 || bytes > MAX_BYTES)
          throw Error("State identity resource limit exceeded");
        hash.update(data + "\n");
      }
    }
    for (const file of inventory.filter(
      (f) => !["runtime.sqlite", "runtime.sqlite-wal"].includes(f.path),
    ))
      hash.update(JSON.stringify(readStable(root, file)));
    return { fingerprint: hash.digest("hex"), rows };
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}
