-- schema v30 snapshot: room work provenance, before queued steer attachment context (v31)
-- seeded from decf8cfca70fabf81d22994f939594ae53664c0a by scripts/migration-fixtures/generate.mjs (regenerate, do not edit)
-- seed ids: {"version":30,"chatId":"session_f9125f2399eb442c9b4f2edfdc83a258","taskId":"task_832154bdc2ca4de9bd934f02298cf1cd","taskSessionId":"session_48708df2aef54c89a4bc86dedbe688cb","approvalId":"approval_4247bf9f4a8d454c92f2f227ad3586c3","bots":{"researcher":{"id":"researcher","agentId":"researcher","sessionId":"session_5c1ee7536fc84ab7adb6eb7286d36677"},"planner":{"id":"planner","agentId":"planner","sessionId":"session_3c9fc38a36c74bf79e82abd845023792"},"childSessionId":"session_ba9dbe22984d4e22b4511daf5a2e91cd"}}
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE agent_cases (
          id TEXT PRIMARY KEY,
          namespace TEXT,
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          task_fingerprint TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','partial')),
          signals_json TEXT,
          what_worked TEXT,
          what_failed TEXT,
          pivot_hint TEXT,
          applicable_when TEXT,
          not_applicable_when TEXT,
          confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
          source TEXT NOT NULL CHECK(source IN ('reviewer','manual','import')),
          embedding_json TEXT,
          recall_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          extra_json TEXT NOT NULL DEFAULT '{}'
        , status TEXT NOT NULL DEFAULT 'active', half_life_days REAL NOT NULL DEFAULT 30, expires_at TEXT);
CREATE TABLE agent_memory (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL DEFAULT 'session.scratch',
          namespace TEXT NOT NULL DEFAULT 'default',
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          user_id TEXT,
          tenant_id TEXT,
          session_id TEXT,
          importance REAL NOT NULL DEFAULT 0.5,
          source TEXT,
          confidence TEXT NOT NULL DEFAULT 'medium',
          expires_at TEXT,
          access_count INTEGER NOT NULL DEFAULT 0,
          last_access_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        , agent_id TEXT);
INSERT INTO "agent_memory" ("id", "scope", "namespace", "key", "value", "user_id", "tenant_id", "session_id", "importance", "source", "confidence", "expires_at", "access_count", "last_access_at", "created_at", "updated_at", "agent_id") VALUES ('amem_a89227e602154ca1b7546dc024606752', 'user.memory', 'default', 'shared-pref', 'prefers short answers (general chat)', 'u1', NULL, 'session_f9125f2399eb442c9b4f2edfdc83a258', 0.5, NULL, 'medium', NULL, 0, '2026-10-19T07:30:18.466Z', '2026-10-19T07:30:18.466Z', '2026-10-19T07:30:18.466Z', NULL);
INSERT INTO "agent_memory" ("id", "scope", "namespace", "key", "value", "user_id", "tenant_id", "session_id", "importance", "source", "confidence", "expires_at", "access_count", "last_access_at", "created_at", "updated_at", "agent_id") VALUES ('amem_cfa749e528334cfdba304a068c372e7d', 'user.memory', 'default', 'global-pref', 'timezone UTC (no session)', 'u1', NULL, NULL, 0.5, NULL, 'medium', NULL, 0, '2026-10-19T07:30:18.466Z', '2026-10-19T07:30:18.466Z', '2026-10-19T07:30:18.466Z', NULL);
INSERT INTO "agent_memory" ("id", "scope", "namespace", "key", "value", "user_id", "tenant_id", "session_id", "importance", "source", "confidence", "expires_at", "access_count", "last_access_at", "created_at", "updated_at", "agent_id") VALUES ('amem_b5c9ed09cd354eb498952fac570bd9c1', 'session.long', 'default', 'chat-long', 'plain chat long note', NULL, NULL, 'session_f9125f2399eb442c9b4f2edfdc83a258', 0.5, NULL, 'medium', NULL, 0, '2026-10-19T07:30:18.466Z', '2026-10-19T07:30:18.466Z', '2026-10-19T07:30:18.466Z', NULL);
INSERT INTO "agent_memory" ("id", "scope", "namespace", "key", "value", "user_id", "tenant_id", "session_id", "importance", "source", "confidence", "expires_at", "access_count", "last_access_at", "created_at", "updated_at", "agent_id") VALUES ('amem_a775bd503a6c4b399e4770275ef52f88', 'user.memory', 'default', 'bot-pref', 'likes tea (written by Researcher)', 'u1', NULL, 'session_5c1ee7536fc84ab7adb6eb7286d36677', 0.5, NULL, 'medium', NULL, 0, '2026-10-19T07:30:18.468Z', '2026-10-19T07:30:18.468Z', '2026-10-19T07:30:18.468Z', NULL);
INSERT INTO "agent_memory" ("id", "scope", "namespace", "key", "value", "user_id", "tenant_id", "session_id", "importance", "source", "confidence", "expires_at", "access_count", "last_access_at", "created_at", "updated_at", "agent_id") VALUES ('amem_668fdd9a737f480fa6c1e56b0446edec', 'user.memory', 'default', 'bot-child-pref', 'cites sources (Researcher subagent)', 'u1', NULL, 'session_ba9dbe22984d4e22b4511daf5a2e91cd', 0.5, NULL, 'medium', NULL, 0, '2026-10-19T07:30:18.468Z', '2026-10-19T07:30:18.468Z', '2026-10-19T07:30:18.468Z', NULL);
INSERT INTO "agent_memory" ("id", "scope", "namespace", "key", "value", "user_id", "tenant_id", "session_id", "importance", "source", "confidence", "expires_at", "access_count", "last_access_at", "created_at", "updated_at", "agent_id") VALUES ('amem_22ea092e2e3b450fbe34292cd137b83a', 'session.long', 'default', 'bot-long', 'Researcher long note', NULL, NULL, 'session_5c1ee7536fc84ab7adb6eb7286d36677', 0.5, NULL, 'medium', NULL, 0, '2026-10-19T07:30:18.468Z', '2026-10-19T07:30:18.468Z', '2026-10-19T07:30:18.468Z', NULL);
CREATE TABLE agent_memory_embedding (
          memory_id TEXT PRIMARY KEY,
          model TEXT,
          embedding_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE TABLE agent_memory_sources(memory_id TEXT PRIMARY KEY, refs_json TEXT NOT NULL);
CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
INSERT INTO "agents" ("id", "name", "role", "spec_json", "created_at", "updated_at") VALUES ('general', 'General', 'assistant', '{"id":"general","name":"General","role":"assistant","instructions":"General assistant.","capabilities":["tool-use"]}', '2026-10-19T07:30:18.464Z', '2026-10-19T07:30:18.464Z');
INSERT INTO "agents" ("id", "name", "role", "spec_json", "created_at", "updated_at") VALUES ('reviewer', 'Reviewer', 'reviewer', '{"id":"reviewer","name":"Reviewer","role":"reviewer","instructions":"Reviews changes.","capabilities":[]}', '2026-10-19T07:30:18.464Z', '2026-10-19T07:30:18.464Z');
INSERT INTO "agents" ("id", "name", "role", "spec_json", "created_at", "updated_at") VALUES ('researcher', 'Researcher', 'Researcher', '{"id":"researcher","name":"Researcher","role":"Researcher","instructions":"You are Researcher.\nlegacy bot (default permission)\nYou are a named persistent teammate. Continue this conversation; do not treat it as a disposable chat.\nYou choose the execution style for each request — do not ask the user to pick Chat / Task / Orchestrator / Self-Heal / Planner / Generator / Evaluator.\nQ&A: answer directly. Multi-step or implementation: TodoWrite, tools, task_create. Cross-cutting work: orchestrate teammates or spawn_subagent. Research/plan/implement/review as the task requires.\nWhether a tool call needs approval is decided by this session''s permissionMode.\nThis is a long-lived conversation. Older turns are compacted and keyframes are kept (session cut); do not ask the user to start a new chat.","capabilities":["bot","tool-use","task-management","orchestration"],"autonomous":true,"domainId":"bot"}', '2026-10-19T07:30:18.467Z', '2026-10-19T07:30:18.467Z');
INSERT INTO "agents" ("id", "name", "role", "spec_json", "created_at", "updated_at") VALUES ('planner', 'Planner', 'Planner', '{"id":"planner","name":"Planner","role":"Planner","instructions":"You are Planner.\nlegacy bot the user moved to ask\nYou are a named persistent teammate. Continue this conversation; do not treat it as a disposable chat.\nYou choose the execution style for each request — do not ask the user to pick Chat / Task / Orchestrator / Self-Heal / Planner / Generator / Evaluator.\nQ&A: answer directly. Multi-step or implementation: TodoWrite, tools, task_create. Cross-cutting work: orchestrate teammates or spawn_subagent. Research/plan/implement/review as the task requires.\nWhether a tool call needs approval is decided by this session''s permissionMode.\nThis is a long-lived conversation. Older turns are compacted and keyframes are kept (session cut); do not ask the user to start a new chat.","capabilities":["bot","tool-use","task-management","orchestration"],"autonomous":true,"domainId":"bot"}', '2026-10-19T07:30:18.467Z', '2026-10-19T07:30:18.467Z');
CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        args_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , idempotency_key TEXT, expires_at TEXT, expire_reason TEXT, wake_source TEXT);
INSERT INTO "approvals" ("id", "session_id", "tool_name", "status", "reason", "args_json", "created_at", "updated_at", "idempotency_key", "expires_at", "expire_reason", "wake_source") VALUES ('approval_4247bf9f4a8d454c92f2f227ad3586c3', 'session_48708df2aef54c89a4bc86dedbe688cb', 'bash', 'pending', 'writes files', '{"command":"touch x"}', '2026-10-19T07:30:18.466Z', '2026-10-19T07:30:18.466Z', NULL, NULL, NULL, NULL);
CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          source_tool TEXT NOT NULL,
          file_name TEXT,
          mime_type TEXT NOT NULL,
          local_rel_path TEXT NOT NULL,
          total_bytes INTEGER NOT NULL,
          total_chars INTEGER NOT NULL,
          page_size_chars INTEGER NOT NULL,
          total_pages INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
CREATE TABLE attachments (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          file_name TEXT NOT NULL,
          mime_type TEXT,
          kind TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_url TEXT,
          local_rel_path TEXT,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          status_reason TEXT,
          encoding TEXT,
          image_asset_id TEXT,
          artifact_handle TEXT,
          emit_text TEXT,
          created_at TEXT NOT NULL
        );
CREATE TABLE auth_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
CREATE TABLE background_jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE bot_definition_owners(bot_id TEXT PRIMARY KEY,principal TEXT NOT NULL);
INSERT INTO "bot_definition_owners" ("bot_id", "principal") VALUES ('researcher', '["","installation:principal_5d2fa62f8ebf488b9a9e7352b201510b"]');
INSERT INTO "bot_definition_owners" ("bot_id", "principal") VALUES ('planner', '["","installation:principal_5d2fa62f8ebf488b9a9e7352b201510b"]');
CREATE TABLE bot_room_contexts(room_id TEXT NOT NULL, bot_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(room_id,bot_id));
CREATE TABLE bot_room_messages(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, seq INTEGER NOT NULL, idem_key TEXT, data TEXT NOT NULL, UNIQUE(room_id,seq), UNIQUE(room_id,idem_key));
CREATE TABLE bot_room_turns(id TEXT PRIMARY KEY, room_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE bot_rooms(id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE bot_routine_leases (
    run_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
CREATE TABLE bot_routine_runs(id TEXT PRIMARY KEY,routine_id TEXT NOT NULL,occurrence_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,payload TEXT NOT NULL,notified INTEGER NOT NULL DEFAULT 0);
CREATE TABLE bot_routine_summary_links (
    message_id TEXT PRIMARY KEY, main_session_id TEXT NOT NULL,
    working_session_id TEXT NOT NULL, run_id TEXT NOT NULL
  );
CREATE TABLE bot_work_bindings (principal TEXT NOT NULL,bot_id TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(principal,bot_id));
CREATE TABLE bot_work_leases (session_id TEXT PRIMARY KEY,owner TEXT NOT NULL,fence INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE bot_work_messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,principal TEXT NOT NULL,sender_bot TEXT NOT NULL,target_bot TEXT NOT NULL,session_id TEXT NOT NULL,
 body TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'message',idem TEXT,task_id TEXT,reply_to TEXT,wake INTEGER NOT NULL DEFAULT 1,hop INTEGER NOT NULL DEFAULT 0,source_room TEXT,status TEXT NOT NULL DEFAULT 'pending',
 message_ref TEXT,attempt INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(principal,sender_bot,idem));
CREATE TABLE bot_work_tasks (id TEXT PRIMARY KEY,principal TEXT NOT NULL,requester_bot TEXT NOT NULL,target_bot TEXT NOT NULL,input TEXT NOT NULL,
 idem TEXT,status TEXT NOT NULL DEFAULT 'queued',attempt INTEGER NOT NULL DEFAULT 0,deadline TEXT,result TEXT,failure_reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(principal,requester_bot,idem));
CREATE TABLE bots (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          agent_id TEXT NOT NULL,
          canonical_session_id TEXT NOT NULL,
          hidden INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        , face_shape TEXT, face_color TEXT, avatar TEXT);
INSERT INTO "bots" ("id", "name", "title", "description", "agent_id", "canonical_session_id", "hidden", "created_at", "updated_at", "face_shape", "face_color", "avatar") VALUES ('researcher', 'Researcher', 'Researcher', 'legacy bot (default permission)', 'researcher', 'session_5c1ee7536fc84ab7adb6eb7286d36677', 0, '2026-10-19T07:30:18.467Z', '2026-10-19T07:30:18.467Z', NULL, NULL, NULL);
INSERT INTO "bots" ("id", "name", "title", "description", "agent_id", "canonical_session_id", "hidden", "created_at", "updated_at", "face_shape", "face_color", "avatar") VALUES ('planner', 'Planner', 'Planner', 'legacy bot the user moved to ask', 'planner', 'session_3c9fc38a36c74bf79e82abd845023792', 0, '2026-10-19T07:30:18.467Z', '2026-10-19T07:30:18.467Z', NULL, NULL, NULL);
CREATE TABLE capabilities (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          endpoint TEXT NOT NULL,
          transport TEXT NOT NULL DEFAULT 'https',
          schema_ref TEXT,
          schema_hash TEXT,
          trust TEXT NOT NULL DEFAULT 'untrusted',
          scope TEXT NOT NULL DEFAULT '[]',
          cred_ref TEXT,
          source TEXT NOT NULL DEFAULT 'manual',
          cbom_json TEXT,
          pool TEXT,
          tags_json TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE TABLE capability_bindings (
          id TEXT PRIMARY KEY,
          capability_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          schema_hash_pin TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          bound_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata_json TEXT,
          FOREIGN KEY (capability_id) REFERENCES capabilities(id)
        );
CREATE TABLE cloud_folders (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          backend TEXT NOT NULL,
          local_path TEXT NOT NULL,
          s3_prefix TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE TABLE context_stack_snapshots (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          turn_index INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          blocks_json TEXT NOT NULL
        );
CREATE TABLE daemon_control (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
INSERT INTO "daemon_control" ("key", "value_json", "updated_at") VALUES ('bot.installationPrincipal', '"installation:principal_5d2fa62f8ebf488b9a9e7352b201510b"', '2026-10-19T07:30:18.467Z');
CREATE TABLE goal_records (
          goal_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          close_reason TEXT,
          spec_json TEXT NOT NULL,
          condition TEXT NOT NULL,
          turns_used INTEGER NOT NULL DEFAULT 0,
          max_turns INTEGER NOT NULL DEFAULT 25,
          missing_json TEXT,
          criteria_status_json TEXT,
          ledger_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE TABLE image_assets (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_url TEXT,
        local_rel_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        derived_from_json TEXT NOT NULL,
        retention_tier TEXT NOT NULL,
        kind TEXT NOT NULL,
        last_access_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE mailbox (
        id TEXT PRIMARY KEY,
        from_agent_id TEXT NOT NULL,
        to_agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        correlation_id TEXT,
        session_id TEXT,
        task_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT
      );
CREATE TABLE memberships (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'member',
          PRIMARY KEY (user_id, tenant_id)
        );
CREATE TABLE memory_dream_runs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          tenant_id TEXT,
          dream_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          facts_count INTEGER NOT NULL DEFAULT 0,
          summary TEXT,
          journal TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          UNIQUE(user_id, dream_date)
        );
CREATE TABLE memory_observations (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          session_id TEXT,
          user_id TEXT,
          agent_id TEXT,
          tenant_id TEXT,
          task_content TEXT,
          outcome TEXT,
          tools_used_json TEXT NOT NULL DEFAULT '[]',
          raw_summary TEXT,
          gate TEXT NOT NULL DEFAULT 'pending',
          gate_reason TEXT,
          written_memory_id TEXT,
          created_at TEXT NOT NULL
        );
CREATE TABLE oauth_identities (
          provider TEXT NOT NULL,
          provider_user_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          email TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (provider, provider_user_id)
        );
CREATE TABLE oauth_states (
          state TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          code_verifier TEXT,
          redirect_to TEXT,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
CREATE TABLE orchestration_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
          step_id TEXT,
          kind TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT '',
          payload_json TEXT,
          created_at TEXT NOT NULL
        );
CREATE TABLE orchestration_runs (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT '',
          source_ref TEXT NOT NULL DEFAULT '',
          flywheels TEXT NOT NULL DEFAULT '[]',
          capability_tags TEXT NOT NULL DEFAULT '[]',
          risk_level TEXT NOT NULL DEFAULT 'low',
          status TEXT NOT NULL DEFAULT 'pending',
          budget TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE TABLE orchestration_steps (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
          stage TEXT NOT NULL,
          executor TEXT NOT NULL DEFAULT '',
          input_artifact TEXT,
          output_artifact TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          failure_type TEXT,
          next_action TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE TABLE project_roots (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          path TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0,
          UNIQUE(project_id, alias)
        );
CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE TABLE research_claims (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          confidence TEXT NOT NULL DEFAULT 'medium',
          evidence_ids TEXT NOT NULL DEFAULT '[]',
          caveats TEXT,
          created_at TEXT NOT NULL
        );
CREATE TABLE research_evidence (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES research_sources(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
          quote TEXT NOT NULL,
          location TEXT,
          relevance REAL NOT NULL DEFAULT 0.5
        );
CREATE TABLE research_sources (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL DEFAULT 'web',
          url TEXT,
          title TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          trust_level TEXT NOT NULL DEFAULT 'unknown'
        );
CREATE TABLE research_tasks (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          scope TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          capability_tags TEXT NOT NULL DEFAULT '[]',
          report_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE TABLE resource_owners (
          kind TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          tenant_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (kind, resource_id)
        );
CREATE TABLE scheduler_wake (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT NOT NULL
    );
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (1, '2026-10-19T07:30:18.452Z', 'baseline (initial schema applied by storage.ts top-level DDL)');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (2, '2026-10-19T07:30:18.453Z', 'add approvals.idempotency_key');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (3, '2026-10-19T07:30:18.454Z', 'session_memory consolidation columns');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (4, '2026-10-19T07:30:18.454Z', 'agent_cases + fts for evolving / case recall');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (5, '2026-10-19T07:30:18.454Z', 'orchestration_runs / orchestration_steps / orchestration_events tables');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (6, '2026-10-19T07:30:18.454Z', 'deep research tables: tasks / sources / evidence / claims');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (7, '2026-10-19T07:30:18.455Z', 'users / tenants / memberships / agent_memory multi-layer memory tables');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (8, '2026-10-19T07:30:18.455Z', 'swarm_runs / swarm_tasks / swarm_reviews tables for Teams Swarm');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (9, '2026-10-19T07:30:18.455Z', 'migrate session_memory rows into agent_memory (session.scratch / session.long)');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (10, '2026-10-19T07:30:18.456Z', 'agent_cases status / half_life_days / expires_at for case governance');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (11, '2026-10-19T07:30:18.456Z', 'capability discovery registry (capabilities + capability_bindings)');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (12, '2026-10-19T07:30:18.457Z', 'session_messages surface algebra: seq / key / surface_op / replaces_*');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (13, '2026-10-19T07:30:18.457Z', 'session_inbox for next-step / next-run steer');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (14, '2026-10-19T07:30:18.457Z', 'sessions.active_writer_run_id WAL writer claim');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (15, '2026-10-19T07:30:18.457Z', 'bots roster + canonical session binding');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (16, '2026-10-19T07:30:18.457Z', 'user_profiles + memory_observations + memory_dream_runs + agent_memory FTS triggers');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (17, '2026-10-19T07:30:18.458Z', 'goal_records + team_plans DAG');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (18, '2026-10-19T07:30:18.458Z', 'attachments + artifacts tables for ingestion / paged artifact');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (19, '2026-10-19T07:30:18.458Z', 'projects + project_roots + cloud_folders for workspace binding');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (20, '2026-10-19T07:30:18.459Z', 'oauth identities + auth sessions + user avatar');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (21, '2026-10-19T07:30:18.459Z', 'agent_memory.agent_id isolates bot memory from shared user.memory');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (22, '2026-10-19T07:30:18.459Z', 'move pre-v21 bot memory into the bot namespace; flag bots that got bypass by default; drop FTS triggers without FTS5');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (23, '2026-10-19T07:30:18.460Z', 'resource_owners records the Lab user that created owner-less resources (swarm, research, ...)');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (24, '2026-10-19T07:30:18.461Z', 'approvals.expires_at / expire_reason / wake_source for unattended fail-safe deny');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (25, '2026-10-19T07:30:18.462Z', 'Reliable Bot work, Rooms, Routine runs, history index and memory source references');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (26, '2026-10-19T07:30:18.463Z', 'bots.face_shape and bots.face_color for a saved living-face choice');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (27, '2026-10-19T07:30:18.463Z', 'routine occurrence leases and summary continuation links');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (28, '2026-10-19T07:30:18.463Z', 'context_stack_snapshots for Play context replay');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (29, '2026-10-19T07:30:18.463Z', 'bots.avatar for an optional emoji or image URL');
INSERT INTO "schema_version" ("version", "applied_at", "description") VALUES (30, '2026-10-19T07:30:18.464Z', 'bot_work_messages.source_room records the Room a 1:1 private message came from');
CREATE TABLE self_heal_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE self_heal_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        task_id TEXT,
        session_id TEXT,
        workspace_id TEXT,
        worktree_branch TEXT,
        fix_iteration INTEGER NOT NULL DEFAULT 0,
        last_error_summary TEXT,
        last_test_output TEXT,
        merge_commit_sha TEXT,
        block_reason TEXT,
        stopped INTEGER NOT NULL DEFAULT 0,
        restart_requested_at TEXT,
        restart_ack_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE session_inbox (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        target TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        key TEXT,
        created_at TEXT NOT NULL,
        claimed_at TEXT
      );
CREATE TABLE session_memory (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        updated_at TEXT NOT NULL, importance REAL DEFAULT 0.5, access_count INTEGER DEFAULT 0, last_access_at TEXT, source TEXT, merged_from_json TEXT,
        UNIQUE(session_id, scope, key)
      );
CREATE TABLE session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        parts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        seq INTEGER,
        key TEXT,
        surface_op TEXT DEFAULT 'append',
        replaces_start INTEGER,
        replaces_end INTEGER
      );
INSERT INTO "session_messages" ("id", "session_id", "role", "parts_json", "created_at", "seq", "key", "surface_op", "replaces_start", "replaces_end") VALUES ('msg_effd71167f7f465e818064bd6b18e501', 'session_f9125f2399eb442c9b4f2edfdc83a258', 'user', '[{"type":"text","text":"list the repo files"}]', '2026-10-19T07:30:18.464Z', 1, NULL, 'append', NULL, NULL);
INSERT INTO "session_messages" ("id", "session_id", "role", "parts_json", "created_at", "seq", "key", "surface_op", "replaces_start", "replaces_end") VALUES ('msg_180d0a5c899f41ccb38b856b7b1d211a', 'session_f9125f2399eb442c9b4f2edfdc83a258', 'assistant', '[{"type":"text","text":"Listing."},{"type":"tool_call","toolCallId":"call_seed_1","name":"bash","input":{"command":"ls"}}]', '2026-10-19T07:30:18.465Z', 2, NULL, 'append', NULL, NULL);
INSERT INTO "session_messages" ("id", "session_id", "role", "parts_json", "created_at", "seq", "key", "surface_op", "replaces_start", "replaces_end") VALUES ('msg_5e29e714edfa43c2a9add709eff61bab', 'session_f9125f2399eb442c9b4f2edfdc83a258', 'tool', '[{"type":"tool_result","toolCallId":"call_seed_1","name":"bash","ok":true,"content":"README.md"}]', '2026-10-19T07:30:18.465Z', 3, NULL, 'append', NULL, NULL);
INSERT INTO "session_messages" ("id", "session_id", "role", "parts_json", "created_at", "seq", "key", "surface_op", "replaces_start", "replaces_end") VALUES ('msg_ce62a9f758614f3390fbdb654423a049', 'session_f9125f2399eb442c9b4f2edfdc83a258', 'assistant', '[{"type":"text","text":"One file: README.md."}]', '2026-10-19T07:30:18.465Z', 4, NULL, 'append', NULL, NULL);
INSERT INTO "session_messages" ("id", "session_id", "role", "parts_json", "created_at", "seq", "key", "surface_op", "replaces_start", "replaces_end") VALUES ('msg_830d8794e6eb4e21b523c416dd18fc65', 'session_48708df2aef54c89a4bc86dedbe688cb', 'user', '[{"type":"text","text":"review it"}]', '2026-10-19T07:30:18.465Z', 1, NULL, 'append', NULL, NULL);
INSERT INTO "session_messages" ("id", "session_id", "role", "parts_json", "created_at", "seq", "key", "surface_op", "replaces_start", "replaces_end") VALUES ('msg_35818139dd1e46bdb5851b113377c050', 'session_5c1ee7536fc84ab7adb6eb7286d36677', 'user', '[{"type":"text","text":"remember I like tea"}]', '2026-10-19T07:30:18.467Z', 1, NULL, 'append', NULL, NULL);
CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        task_id TEXT,
        workspace_id TEXT,
        parent_session_id TEXT,
        background INTEGER NOT NULL,
        summary TEXT,
        todo_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , active_writer_run_id TEXT);
INSERT INTO "sessions" ("id", "title", "mode", "status", "agent_id", "task_id", "workspace_id", "parent_session_id", "background", "summary", "todo_json", "metadata_json", "created_at", "updated_at", "active_writer_run_id") VALUES ('session_f9125f2399eb442c9b4f2edfdc83a258', 'plain chat', 'chat', 'idle', 'general', NULL, NULL, NULL, 0, NULL, '[]', '{"userId":"u1"}', '2026-10-19T07:30:18.464Z', '2026-10-19T07:30:18.465Z', NULL);
INSERT INTO "sessions" ("id", "title", "mode", "status", "agent_id", "task_id", "workspace_id", "parent_session_id", "background", "summary", "todo_json", "metadata_json", "created_at", "updated_at", "active_writer_run_id") VALUES ('session_48708df2aef54c89a4bc86dedbe688cb', 'task session', 'task', 'idle', 'reviewer', 'task_832154bdc2ca4de9bd934f02298cf1cd', NULL, NULL, 0, NULL, '[]', '{}', '2026-10-19T07:30:18.465Z', '2026-10-19T07:30:18.465Z', NULL);
INSERT INTO "sessions" ("id", "title", "mode", "status", "agent_id", "task_id", "workspace_id", "parent_session_id", "background", "summary", "todo_json", "metadata_json", "created_at", "updated_at", "active_writer_run_id") VALUES ('session_5c1ee7536fc84ab7adb6eb7286d36677', 'Bot Chat · Researcher', 'chat', 'idle', 'researcher', NULL, NULL, NULL, 0, NULL, '[]', '{"botId":"researcher","canonicalBotChat":true,"sessionCut":true,"permissionMode":"auto","maxTurns":24,"userId":"installation:principal_5d2fa62f8ebf488b9a9e7352b201510b"}', '2026-10-19T07:30:18.467Z', '2026-10-19T07:30:18.467Z', NULL);
INSERT INTO "sessions" ("id", "title", "mode", "status", "agent_id", "task_id", "workspace_id", "parent_session_id", "background", "summary", "todo_json", "metadata_json", "created_at", "updated_at", "active_writer_run_id") VALUES ('session_3c9fc38a36c74bf79e82abd845023792', 'Bot Chat · Planner', 'chat', 'idle', 'planner', NULL, NULL, NULL, 0, NULL, '[]', '{"botId":"planner","canonicalBotChat":true,"sessionCut":true,"permissionMode":"ask","maxTurns":24,"userId":"installation:principal_5d2fa62f8ebf488b9a9e7352b201510b","permissionModeChangedAt":"2026-08-02T00:00:00.000Z"}', '2026-10-19T07:30:18.467Z', '2026-10-19T07:30:18.467Z', NULL);
INSERT INTO "sessions" ("id", "title", "mode", "status", "agent_id", "task_id", "workspace_id", "parent_session_id", "background", "summary", "todo_json", "metadata_json", "created_at", "updated_at", "active_writer_run_id") VALUES ('session_ba9dbe22984d4e22b4511daf5a2e91cd', 'researcher subagent', 'subagent', 'idle', 'helper', NULL, NULL, 'session_5c1ee7536fc84ab7adb6eb7286d36677', 0, NULL, '[]', '{}', '2026-10-19T07:30:18.468Z', '2026-10-19T07:30:18.468Z', NULL);
CREATE TABLE software_invocations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      principal TEXT NOT NULL, bot_id TEXT NOT NULL, connector_id TEXT NOT NULL,
      state TEXT NOT NULL, write_effect INTEGER NOT NULL, session_id TEXT, task_id TEXT,
      request_hash TEXT, fingerprint TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL, payload TEXT NOT NULL
    );
CREATE TABLE swarm_reviews (
          id TEXT PRIMARY KEY,
          swarm_run_id TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          reviewer_agent_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'reviewer',
          scores TEXT NOT NULL DEFAULT '{}',
          passed INTEGER NOT NULL DEFAULT 0,
          feedback TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
CREATE TABLE swarm_runs (
          id TEXT PRIMARY KEY,
          goal TEXT NOT NULL,
          orchestration_run_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          strategy TEXT NOT NULL DEFAULT 'pipeline',
          budget TEXT NOT NULL DEFAULT '{"maxTeammates":3,"maxTurnsPerAgent":20,"maxDurationMs":600000}',
          quality_gate TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE TABLE swarm_tasks (
          id TEXT PRIMARY KEY,
          swarm_run_id TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          required_role TEXT NOT NULL DEFAULT 'implementer',
          owner_agent_id TEXT,
          capability_tags TEXT NOT NULL DEFAULT '[]',
          acceptance_criteria TEXT NOT NULL DEFAULT '[]',
          artifacts TEXT NOT NULL DEFAULT '[]',
          blocked_by TEXT NOT NULL DEFAULT '[]',
          budget TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE TABLE task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
INSERT INTO "task_events" ("id", "task_id", "kind", "actor", "payload_json", "created_at") VALUES ('evt_45624602f7ef4561a3105ecbc6d38bf8', 'task_832154bdc2ca4de9bd934f02298cf1cd', 'task.created', 'reviewer', '{"title":"seeded task","sessionId":null,"parentTaskId":null}', '2026-10-19T07:30:18.465Z');
CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_agent_id TEXT,
        session_id TEXT,
        parent_task_id TEXT,
        workspace_id TEXT,
        blocked_by_json TEXT NOT NULL,
        artifacts_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
INSERT INTO "tasks" ("id", "title", "description", "status", "owner_agent_id", "session_id", "parent_task_id", "workspace_id", "blocked_by_json", "artifacts_json", "metadata_json", "created_at", "updated_at") VALUES ('task_832154bdc2ca4de9bd934f02298cf1cd', 'seeded task', 'carry over', 'pending', 'reviewer', NULL, NULL, NULL, '[]', '[]', '{}', '2026-10-19T07:30:18.465Z', '2026-10-19T07:30:18.465Z');
CREATE TABLE team_plan_reviews (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          passed INTEGER NOT NULL DEFAULT 0,
          feedback TEXT NOT NULL DEFAULT '',
          reviewer_agent_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
CREATE TABLE team_plans (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          tasks_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
CREATE TABLE tenants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
CREATE TABLE user_profiles (
          user_id TEXT PRIMARY KEY,
          display_name TEXT,
          bio TEXT,
          facts_json TEXT NOT NULL DEFAULT '[]',
          preferences_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL
        );
CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE,
          display_name TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL
        , avatar_url TEXT);
INSERT INTO "users" ("id", "email", "display_name", "status", "created_at", "avatar_url") VALUES ('u1', 'user-one@example.invalid', 'User One', 'active', '2026-08-01T00:00:00.000Z', NULL);
CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mode TEXT NOT NULL,
        source_path TEXT NOT NULL,
        root_path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE VIRTUAL TABLE agent_cases_fts USING fts5(
          body,
          case_id UNINDEXED,
          tokenize = 'unicode61'
        );
CREATE VIRTUAL TABLE agent_memory_fts USING fts5(
            key,
            value,
            content=agent_memory,
            content_rowid=rowid
          );
INSERT INTO "agent_memory_fts"("agent_memory_fts") VALUES ('rebuild');
CREATE VIRTUAL TABLE session_history_fts USING fts5(message_id UNINDEXED, session_id UNINDEXED, text, tokenize='trigram');
INSERT INTO "session_history_fts" ("rowid", "message_id", "session_id", "text") VALUES (1, 'msg_effd71167f7f465e818064bd6b18e501', 'session_f9125f2399eb442c9b4f2edfdc83a258', '[{"type":"text","text":"list the repo files"}]');
INSERT INTO "session_history_fts" ("rowid", "message_id", "session_id", "text") VALUES (2, 'msg_180d0a5c899f41ccb38b856b7b1d211a', 'session_f9125f2399eb442c9b4f2edfdc83a258', '[{"type":"text","text":"Listing."},{"type":"tool_call","toolCallId":"call_seed_1","name":"bash","input":{"command":"ls"}}]');
INSERT INTO "session_history_fts" ("rowid", "message_id", "session_id", "text") VALUES (3, 'msg_5e29e714edfa43c2a9add709eff61bab', 'session_f9125f2399eb442c9b4f2edfdc83a258', '[{"type":"tool_result","toolCallId":"call_seed_1","name":"bash","ok":true,"content":"README.md"}]');
INSERT INTO "session_history_fts" ("rowid", "message_id", "session_id", "text") VALUES (4, 'msg_ce62a9f758614f3390fbdb654423a049', 'session_f9125f2399eb442c9b4f2edfdc83a258', '[{"type":"text","text":"One file: README.md."}]');
INSERT INTO "session_history_fts" ("rowid", "message_id", "session_id", "text") VALUES (5, 'msg_830d8794e6eb4e21b523c416dd18fc65', 'session_48708df2aef54c89a4bc86dedbe688cb', '[{"type":"text","text":"review it"}]');
INSERT INTO "session_history_fts" ("rowid", "message_id", "session_id", "text") VALUES (6, 'msg_35818139dd1e46bdb5851b113377c050', 'session_5c1ee7536fc84ab7adb6eb7286d36677', '[{"type":"text","text":"remember I like tea"}]');
CREATE INDEX bot_room_messages_page ON bot_room_messages(room_id,seq);
CREATE INDEX bot_room_turns_queue ON bot_room_turns(room_id,status);
CREATE INDEX bot_room_turns_status ON bot_room_turns(status);
CREATE INDEX bot_rooms_principal ON bot_rooms(principal_id);
CREATE INDEX bot_work_pending ON bot_work_messages(status,seq);
CREATE INDEX idx_agent_cases_agent ON agent_cases(agent_id, created_at DESC);
CREATE INDEX idx_agent_cases_namespace ON agent_cases(namespace, agent_id);
CREATE INDEX idx_agent_cases_session ON agent_cases(session_id);
CREATE INDEX idx_agent_cases_status ON agent_cases(status, agent_id);
CREATE INDEX idx_agent_memory_agent_id ON agent_memory(agent_id);
CREATE INDEX idx_agent_memory_expires_at ON agent_memory(expires_at);
CREATE INDEX idx_agent_memory_scope_key ON agent_memory(scope, namespace, key);
CREATE INDEX idx_agent_memory_session_id ON agent_memory(session_id);
CREATE INDEX idx_agent_memory_tenant_id ON agent_memory(tenant_id);
CREATE INDEX idx_agent_memory_user_id ON agent_memory(user_id);
CREATE INDEX idx_approvals_status ON approvals(status);
CREATE INDEX idx_artifacts_session ON artifacts(session_id, created_at);
CREATE INDEX idx_attachments_session ON attachments(session_id, created_at);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX idx_bg_jobs_status ON background_jobs(status, updated_at);
CREATE INDEX idx_bot_routine_notify ON bot_routine_runs(notified);
CREATE INDEX idx_bot_routine_runs ON bot_routine_runs(routine_id,status);
CREATE INDEX idx_bot_routine_status ON bot_routine_runs(status);
CREATE INDEX idx_bots_canonical_session ON bots(canonical_session_id);
CREATE INDEX idx_bots_hidden ON bots(hidden);
CREATE UNIQUE INDEX idx_bots_name_nocase ON bots(name COLLATE NOCASE);
CREATE INDEX idx_capabilities_kind ON capabilities(kind);
CREATE INDEX idx_capabilities_pool ON capabilities(pool);
CREATE INDEX idx_capabilities_trust ON capabilities(trust);
CREATE INDEX idx_capability_bindings_cap
          ON capability_bindings(capability_id, status);
CREATE INDEX idx_context_stack_snapshots_session
          ON context_stack_snapshots(session_id, turn_index, created_at);
CREATE INDEX idx_events_task ON task_events(task_id, created_at);
CREATE INDEX idx_goal_records_session
          ON goal_records(session_id, updated_at DESC);
CREATE INDEX idx_goal_records_status
          ON goal_records(status);
CREATE INDEX idx_history_session_time ON session_messages(session_id,created_at,seq);
CREATE INDEX idx_image_assets_session ON image_assets(session_id, created_at);
CREATE INDEX idx_image_assets_sha ON image_assets(session_id, sha256);
CREATE INDEX idx_mail_to_status ON mailbox(to_agent_id, status, created_at);
CREATE INDEX idx_memory_dream_user ON memory_dream_runs(user_id, dream_date);
CREATE INDEX idx_memory_obs_session ON memory_observations(session_id, created_at DESC);
CREATE INDEX idx_memory_obs_user ON memory_observations(user_id, created_at DESC);
CREATE INDEX idx_messages_session ON session_messages(session_id, created_at);
CREATE INDEX idx_oauth_identities_user ON oauth_identities(user_id);
CREATE INDEX idx_orchestration_events_run_id ON orchestration_events(run_id);
CREATE INDEX idx_orchestration_runs_status ON orchestration_runs(status);
CREATE INDEX idx_orchestration_steps_run_id ON orchestration_steps(run_id);
CREATE INDEX idx_project_roots_project ON project_roots(project_id);
CREATE INDEX idx_research_claims_task_id ON research_claims(task_id);
CREATE INDEX idx_research_evidence_task_id ON research_evidence(task_id);
CREATE INDEX idx_research_sources_task_id ON research_sources(task_id);
CREATE INDEX idx_research_tasks_status ON research_tasks(status);
CREATE INDEX idx_resource_owners_user ON resource_owners(kind, user_id);
CREATE INDEX idx_routine_summary_main ON bot_routine_summary_links(main_session_id);
CREATE INDEX idx_scheduler_wake_created ON scheduler_wake(created_at ASC);
CREATE INDEX idx_self_heal_events_run ON self_heal_events(run_id, created_at);
CREATE INDEX idx_self_heal_runs_status ON self_heal_runs(status, updated_at);
CREATE INDEX idx_session_inbox_claim
        ON session_inbox(session_id, target, claimed_at);
CREATE INDEX idx_session_memory_session ON session_memory(session_id, scope);
CREATE INDEX idx_session_messages_key ON session_messages(session_id, key);
CREATE UNIQUE INDEX idx_session_messages_seq ON session_messages(session_id, seq);
CREATE INDEX idx_sessions_agent ON sessions(agent_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_swarm_reviews_run_id ON swarm_reviews(swarm_run_id);
CREATE INDEX idx_swarm_runs_status ON swarm_runs(status);
CREATE INDEX idx_swarm_tasks_run_id ON swarm_tasks(swarm_run_id);
CREATE INDEX idx_swarm_tasks_status ON swarm_tasks(status);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_team_plan_reviews_plan ON team_plan_reviews(plan_id);
CREATE INDEX idx_team_plans_session ON team_plans(session_id);
CREATE INDEX idx_team_plans_status ON team_plans(status);
CREATE INDEX idx_workspaces_task ON workspaces(task_id);
CREATE INDEX software_invocations_request ON software_invocations(request_hash,state,write_effect);
CREATE INDEX software_invocations_scope ON software_invocations(principal,bot_id,connector_id,seq DESC);
CREATE INDEX software_invocations_session ON software_invocations(session_id,state,started_at);
CREATE INDEX software_invocations_state ON software_invocations(state,seq);
CREATE INDEX software_invocations_task ON software_invocations(task_id,state);
CREATE TRIGGER agent_memory_ad AFTER DELETE ON agent_memory BEGIN
            INSERT INTO agent_memory_fts(agent_memory_fts, rowid, key, value)
              VALUES('delete', old.rowid, old.key, old.value);
          END;
CREATE TRIGGER agent_memory_ai AFTER INSERT ON agent_memory BEGIN
            INSERT INTO agent_memory_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
          END;
CREATE TRIGGER agent_memory_au AFTER UPDATE ON agent_memory BEGIN
            INSERT INTO agent_memory_fts(agent_memory_fts, rowid, key, value)
              VALUES('delete', old.rowid, old.key, old.value);
            INSERT INTO agent_memory_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
          END;
CREATE TRIGGER agent_memory_source_delete AFTER DELETE ON agent_memory BEGIN
          DELETE FROM agent_memory_sources WHERE memory_id=old.id;
        END;
CREATE TRIGGER session_history_delete AFTER DELETE ON session_messages BEGIN
          DELETE FROM session_history_fts WHERE message_id=old.id;
        END;
CREATE TRIGGER session_history_insert AFTER INSERT ON session_messages
          WHEN new.surface_op IS NULL OR new.surface_op='append' BEGIN
            INSERT INTO session_history_fts(message_id,session_id,text) VALUES(new.id,new.session_id,new.parts_json);
          END;
COMMIT;
