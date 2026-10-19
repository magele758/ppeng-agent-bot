import { createHash } from "node:crypto";
/** Numeric migration versions alone miss independently created tables, indexes and triggers. */
export function readSchemaIdentity(db) {
  const version = db
    .prepare("SELECT MAX(version) AS v FROM schema_version")
    .get()?.v;
  if (!Number.isSafeInteger(version) || version < 0)
    throw Error("Persistent-state version unavailable");
  const rows = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name,tbl_name",
    )
    .all();
  return {
    version,
    fingerprint: createHash("sha256")
      .update("ppeng-sqlite-schema-v1\n" + JSON.stringify(rows))
      .digest("hex"),
  };
}
export function validStateIdentity(value) {
  return Boolean(
    value &&
    Number.isSafeInteger(value.version) &&
    value.version >= 0 &&
    typeof value.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.fingerprint),
  );
}
export function sameStateIdentity(a, b) {
  return (
    validStateIdentity(a) &&
    validStateIdentity(b) &&
    a.version === b.version &&
    a.fingerprint === b.fingerprint
  );
}
export function parseStateIdentity(result) {
  let value;
  try {
    value = JSON.parse(result.stdout ?? "");
  } catch {
    throw Error("Cannot verify persistent-state identity");
  }
  if (result.status !== 0 || !validStateIdentity(value))
    throw Error("Cannot verify persistent-state identity");
  return { version: value.version, fingerprint: value.fingerprint };
}
export const STATE_IDENTITY_SCRIPT =
  "const {DatabaseSync}=require('node:sqlite');const {createHash}=require('node:crypto');const identify=" +
  readSchemaIdentity.toString() +
  ";const db=new DatabaseSync(require('node:path').join(process.env.RAW_AGENT_STATE_DIR||'/data/state','runtime.sqlite'),{readOnly:true});try{console.log(JSON.stringify(identify(db)));}finally{db.close();}";
