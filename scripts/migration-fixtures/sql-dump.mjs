/**
 * Text dump / load for SQLite state DBs (node:sqlite has no `.dump`).
 *
 * Dump order: plain tables (schema + rows by rowid), views, then FTS virtual tables
 * (their shadow tables are skipped and the index is rebuilt on load), then
 * indexes and triggers — triggers last so loading rows does not fire them.
 */

const FTS_SHADOW_SUFFIXES = ['_data', '_idx', '_content', '_docsize', '_config'];

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function schemaObjects(db) {
  return db
    .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all();
}

function isVirtual(row) {
  return row.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(row.sql);
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function dumpDatabase(db, header = []) {
  const objects = schemaObjects(db);
  const virtualNames = objects.filter(isVirtual).map((row) => row.name);
  const isShadow = (name) => virtualNames.some((vt) => FTS_SHADOW_SUFFIXES.some((s) => name === `${vt}${s}`));
  const lines = [...header.map((h) => `-- ${h}`), 'PRAGMA foreign_keys=OFF;', 'BEGIN;'];

  for (const table of objects.filter((row) => row.type === 'table' && !isVirtual(row) && !isShadow(row.name))) {
    lines.push(`${table.sql};`);
    const rows = db.prepare(`SELECT * FROM ${quoteIdent(table.name)} ORDER BY rowid`).all();
    for (const row of rows) {
      const cols = Object.keys(row);
      lines.push(
        `INSERT INTO ${quoteIdent(table.name)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(', ')});`
      );
    }
  }
  for (const view of objects.filter((row) => row.type === 'view')) lines.push(`${view.sql};`);
  for (const vt of objects.filter(isVirtual)) {
    lines.push(`${vt.sql};`);
    if (/\bcontent\s*=/i.test(vt.sql)) {
      lines.push(`INSERT INTO ${quoteIdent(vt.name)}(${quoteIdent(vt.name)}) VALUES ('rebuild');`);
      continue;
    }
    for (const row of db.prepare(`SELECT rowid AS __rowid, * FROM ${quoteIdent(vt.name)} ORDER BY rowid`).all()) {
      const { __rowid, ...cols } = row;
      const names = ['rowid', ...Object.keys(cols)];
      const values = [__rowid, ...Object.values(cols)];
      lines.push(`INSERT INTO ${quoteIdent(vt.name)} (${names.map(quoteIdent).join(', ')}) VALUES (${values.map(sqlLiteral).join(', ')});`);
    }
  }
  for (const kind of ['index', 'trigger']) {
    for (const obj of objects.filter((row) => row.type === kind)) lines.push(`${obj.sql};`);
  }
  lines.push('COMMIT;', '');
  return lines.join('\n');
}

/** Recreate a dumped DB inside an empty database. */
export function loadSqlDump(db, sql) {
  db.exec(sql);
}
