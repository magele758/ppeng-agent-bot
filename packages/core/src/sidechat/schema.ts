import type { DatabaseSync } from 'node:sqlite';

/**
 * Numeric row keys keep FTS rowids stable even across VACUUM. Negative ids index
 * the quote and title; positive ids index the question and answer of each turn.
 * sidechat_corpus is also the single source for FTS rebuilds and short queries.
 */
export function createSidechatSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sidechat_threads (
      n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      create_request TEXT NOT NULL, message_id TEXT NOT NULL, agent_id TEXT NOT NULL, bot_id TEXT,
      ordinal INTEGER NOT NULL, title TEXT NOT NULL, anchor TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL,
      UNIQUE(owner,session_id,ordinal), UNIQUE(owner,session_id,create_request)
    );
    CREATE INDEX IF NOT EXISTS sidechat_owner_updated ON sidechat_threads(owner,updated DESC);
    CREATE INDEX IF NOT EXISTS sidechat_session ON sidechat_threads(session_id);
    CREATE INDEX IF NOT EXISTS sidechat_quote ON sidechat_threads(owner,lower(trim(json_extract(anchor,'$.quote'))));
    CREATE TABLE IF NOT EXISTS sidechat_turns (
      n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL REFERENCES sidechat_threads(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      error TEXT, run_id TEXT UNIQUE, worker_slot INTEGER, created TEXT NOT NULL,
      UNIQUE(thread_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS sidechat_turn_order ON sidechat_turns(thread_id,n);
    CREATE UNIQUE INDEX IF NOT EXISTS sidechat_running ON sidechat_turns(thread_id) WHERE status='generating';
    CREATE TABLE IF NOT EXISTS sidechat_retries (
      turn_id TEXT NOT NULL REFERENCES sidechat_turns(id) ON DELETE CASCADE, attempt_id TEXT NOT NULL,
      PRIMARY KEY(turn_id,attempt_id)
    );
    CREATE VIEW IF NOT EXISTS sidechat_corpus AS
      SELECT -2*n AS docid,id AS thread_id,'quote' AS field,NULL AS message_id,json_extract(anchor,'$.quote') AS text FROM sidechat_threads
      UNION ALL SELECT -2*n+1,id,'title',NULL,title FROM sidechat_threads
      UNION ALL SELECT 2*n-1,thread_id,'user',id||'_u',question FROM sidechat_turns
      UNION ALL SELECT 2*n,thread_id,'assistant',id||'_a',answer FROM sidechat_turns;
  `);
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS sidechat_fts USING fts5(text,content='sidechat_corpus',content_rowid='docid',tokenize='trigram')"
    );
  } catch (error) {
    if (/no such (module: fts5|tokenizer: trigram)/i.test(String(error))) return;
    throw error;
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sidechat_thread_ai AFTER INSERT ON sidechat_threads BEGIN
      INSERT INTO sidechat_fts(rowid,text) VALUES(-2*NEW.n,json_extract(NEW.anchor,'$.quote')),(-2*NEW.n+1,NEW.title);
    END;
    CREATE TRIGGER IF NOT EXISTS sidechat_thread_ad AFTER DELETE ON sidechat_threads BEGIN
      INSERT INTO sidechat_fts(sidechat_fts,rowid,text) VALUES('delete',-2*OLD.n,json_extract(OLD.anchor,'$.quote')),('delete',-2*OLD.n+1,OLD.title);
    END;
    CREATE TRIGGER IF NOT EXISTS sidechat_turn_ai AFTER INSERT ON sidechat_turns BEGIN
      INSERT INTO sidechat_fts(rowid,text) VALUES(2*NEW.n-1,NEW.question),(2*NEW.n,NEW.answer);
    END;
    CREATE TRIGGER IF NOT EXISTS sidechat_turn_ad AFTER DELETE ON sidechat_turns BEGIN
      INSERT INTO sidechat_fts(sidechat_fts,rowid,text) VALUES('delete',2*OLD.n-1,OLD.question),('delete',2*OLD.n,OLD.answer);
    END;
    CREATE TRIGGER IF NOT EXISTS sidechat_answer_au AFTER UPDATE OF answer ON sidechat_turns WHEN OLD.answer!=NEW.answer BEGIN
      INSERT INTO sidechat_fts(sidechat_fts,rowid,text) VALUES('delete',2*OLD.n,OLD.answer);
      INSERT INTO sidechat_fts(rowid,text) VALUES(2*NEW.n,NEW.answer);
    END;
  `);
}

/** Learning state lives beside the annotation. Titles stay searchable after a rename. */
export function upgradeSidechatLearning(db: DatabaseSync): void {
  addLearningColumns(db);
  const fts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sidechat_fts'").get();
  if (!fts) return;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sidechat_title_au AFTER UPDATE OF title ON sidechat_threads
    WHEN OLD.title != NEW.title BEGIN
      INSERT INTO sidechat_fts(sidechat_fts, rowid, text) VALUES('delete', -2 * OLD.n + 1, OLD.title);
      INSERT INTO sidechat_fts(rowid, text) VALUES(-2 * NEW.n + 1, NEW.title);
    END;
  `);
}

function addLearningColumns(db: DatabaseSync): void {
  const names = new Set(
    (db.prepare('PRAGMA table_info(sidechat_threads)').all() as { name: string }[]).map((column) => column.name)
  );
  if (!names.has('grasp')) {
    db.exec("ALTER TABLE sidechat_threads ADD COLUMN grasp TEXT NOT NULL DEFAULT 'thinking'");
  }
  if (!names.has('note')) db.exec("ALTER TABLE sidechat_threads ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  if (!names.has('note_revision')) {
    db.exec('ALTER TABLE sidechat_threads ADD COLUMN note_revision INTEGER NOT NULL DEFAULT 0');
  }
}
