import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeService } from "../dist/knowledge/index.js";
const actor = (botId) => ({ tenantId: "t", scopeId: "p", botId });
function setup() {
  const db = new DatabaseSync(":memory:");
  const deps = {
    db,
    validateSubmission: () => true,
    validateEvidence: () => true,
    isBotInScope: (t, p, b) =>
      t === "t" && p === "p" && ["a", "b", "c", "super"].includes(b),
  };
  return { db, deps, s: new KnowledgeService(deps) };
}
const input = (id = "local") => ({
  sourceRunId: "run",
  kind: "memory",
  localArtifact: { id, version: 1, kind: "memory" },
  content: "Deploy requires a health check.",
  summary: "Health check",
  reason: "Verified",
  evidenceRefs: [{ sessionId: "s", messageId: id, observedAt: "2026-11-03" }],
  recipientBotIds: ["b"],
});
const policy = {
  superBotId: "super",
  allowedRecipientBotIds: ["b"],
  publishPolicy: "autoWithinScope",
};
test("persistent deduplicated pending submission [AC:bot-daydream-knowledge#AC-1]", () => {
  const { s, deps, db } = setup();
  const first = s.submit(actor("a"), input());
  const again = new KnowledgeService(deps).submit(actor("a"), input());
  assert.equal(first.id, again.id);
  assert.equal(s.listSubmissions(actor("a")).length, 1);
  db.close();
});
test("publish and scope isolation [AC:bot-daydream-knowledge#AC-2]", () => {
  const { s, db } = setup();
  s.savePolicy({ ...actor("super"), admin: true }, policy);
  const sub = s.submit(actor("a"), input());
  const batch = s.startBatch(actor("super"));
  const out = s.decide(actor("super"), batch.id, sub.id, {
    action: "publish",
    reason: "valid",
  });
  assert.equal(
    s.getArtifact(actor("b"), out.publishedArtifact.id).content,
    input().content,
  );
  assert.equal(s.listArtifacts(actor("c")).length, 0);
  assert.throws(
    () =>
      s.getArtifact(
        { ...actor("b"), tenantId: "other" },
        out.publishedArtifact.id,
      ),
    /denied/,
  );
  db.close();
});
test("fixed batch and governance identity [AC:bot-daydream-knowledge#AC-3]", () => {
  const { s, db } = setup();
  s.savePolicy({ ...actor("super"), admin: true }, policy);
  s.submit(actor("a"), input());
  const batch = s.startBatch(actor("super"));
  const late = s.submit(actor("a"), input("late"));
  assert.throws(
    () =>
      s.decide(actor("super"), batch.id, late.id, {
        action: "reject",
        reason: "no",
      }),
    /batch/,
  );
  assert.throws(() => s.startBatch(actor("a")), /denied/);
  db.close();
});
test("lineage and evidence feedback prevent recursion [AC:bot-daydream-knowledge#AC-4]", () => {
  const { s, db } = setup();
  s.savePolicy({ ...actor("super"), admin: true }, policy);
  const sub = s.submit(actor("a"), input());
  const out = s.decide(
    actor("super"),
    s.startBatch(actor("super")).id,
    sub.id,
    { action: "publish", reason: "valid" },
  );
  const ref = out.publishedArtifact;
  assert.throws(
    () =>
      s.submit(actor("b"), {
        ...input("copy"),
        derivedFrom: [ref],
        evidenceRefs: input().evidenceRefs,
      }),
    /new evidence/,
  );
  assert.throws(
    () =>
      s.feedback(actor("b"), {
        artifactId: ref.id,
        artifactVersion: 1,
        kind: "verified",
        description: "read",
        evidenceRefs: input().evidenceRefs,
      }),
    /new evidence/,
  );
  const f = s.feedback(actor("b"), {
    artifactId: ref.id,
    artifactVersion: 1,
    kind: "verified",
    description: "Executed successfully",
    evidenceRefs: [
      { sessionId: "b", messageId: "new", observedAt: "2026-11-03" },
    ],
  });
  assert.equal(f.status, "pending");
  db.close();
});
test("version checks revocation and durable events [AC:bot-daydream-knowledge#AC-5]", () => {
  const { s, deps, db } = setup();
  s.savePolicy({ ...actor("super"), admin: true }, policy);
  const sub = s.submit(actor("a"), input());
  const out = s.decide(
    actor("super"),
    s.startBatch(actor("super")).id,
    sub.id,
    { action: "publish", reason: "valid" },
  );
  const ref = out.publishedArtifact;
  const update = s.submit(actor("a"), {
    ...input("update"),
    targetSharedId: ref.id,
  });
  assert.throws(
    () =>
      s.decide(actor("super"), s.startBatch(actor("super")).id, update.id, {
        action: "publish",
        reason: "update",
        expectedVersion: 0,
      }),
    /version/,
  );
  s.revoke(actor("super"), ref.id, 1);
  assert.throws(() => s.getArtifact(actor("b"), ref.id), /denied/);
  const events = s.listEvents(actor("super"), "index");
  assert.equal(events.length, 2);
  s.ackEvents(actor("super"), "index", events.at(-1).seq);
  assert.equal(
    new KnowledgeService(deps).listEvents(actor("super"), "index").length,
    0,
  );
  db.close();
});

test("governance accepts only the locked batch and publication policy [AC:bot-daydream-knowledge#AC-3]", async () => {
  const { s, db } = setup();
  s.savePolicy({ ...actor("super"), admin: true }, policy);
  const sub = s.submit(actor("a"), input());
  const results = await s.govern(actor("super"), async () =>
    JSON.stringify({
      decisions: [{ id: sub.id, action: "publish", reason: "Verified" }],
    }),
  );
  assert.equal(results[0].status, "accepted");
  s.savePolicy(
    { ...actor("super"), admin: true },
    { ...policy, publishPolicy: "review" },
  );
  let called = false;
  assert.deepEqual(
    await s.govern(actor("super"), async () => {
      called = true;
      return "{}";
    }),
    [],
  );
  assert.equal(called, false);
  db.close();
});
test("trusted host rejects forged artifact and evidence [AC:bot-daydream-knowledge#AC-2]", () => {
  const { s, deps, db } = setup();
  deps.validateSubmission = () => false;
  assert.throws(() => s.submit(actor("a"), input()), /provenance denied/);
  deps.validateSubmission = () => true;
  deps.validateEvidence = () => false;
  assert.throws(() => s.submit(actor("a"), input()), /evidence access denied/);
  db.close();
});

test("disk queue survives actual database reopen [AC:bot-daydream-knowledge#AC-1]", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.db");
  const first = setup();
  first.db.close();
  const db = new DatabaseSync(path);
  const deps = { ...first.deps, db };
  const saved = new KnowledgeService(deps).submit(actor("a"), input());
  db.close();
  const reopened = new DatabaseSync(path);
  try {
    const service = new KnowledgeService({ ...deps, db: reopened });
    assert.equal(service.listSubmissions(actor("a"))[0].id, saved.id);
  } finally {
    reopened.close();
  }
});
test("reference owner cannot be replaced by another contributor [AC:bot-daydream-knowledge#AC-2]", () => {
  const { s, db } = setup();
  s.savePolicy({ ...actor("super"), admin: true }, policy);
  const sub = s.submit(actor("a"), input());
  const published = s.decide(
    actor("super"),
    s.startBatch(actor("super")).id,
    sub.id,
    { action: "publish", reason: "valid" },
  );
  const attempt = s.submit(actor("b"), {
    ...input("rewrite"),
    targetSharedId: published.publishedArtifact.id,
  });
  assert.throws(
    () =>
      s.decide(actor("super"), s.startBatch(actor("super")).id, attempt.id, {
        action: "publish",
        reason: "change",
        expectedVersion: 1,
      }),
    /owner conflict/,
  );
  assert.equal(
    s.getArtifact(actor("b"), published.publishedArtifact.id).version,
    1,
  );
  db.close();
});
test("next governance batch turns feedback into versioned curated knowledge [AC:bot-daydream-knowledge#AC-4]", async () => {
  const { s, db } = setup();
  s.savePolicy({ ...actor("super"), admin: true }, policy);
  const sub = s.submit(actor("a"), { ...input(), publicationMode: "curated" });
  const published = s.decide(
    actor("super"),
    s.startBatch(actor("super")).id,
    sub.id,
    { action: "publish", reason: "valid" },
  );
  const ref = published.publishedArtifact;
  const feedback = s.feedback(actor("b"), {
    artifactId: ref.id,
    artifactVersion: 1,
    kind: "extension",
    description: "Retry health check before accepting",
    evidenceRefs: [
      { sessionId: "b", messageId: "execution", observedAt: "2026-11-03" },
    ],
  });
  await s.govern(actor("super"), async (request) => {
    assert.equal(JSON.parse(request.user).feedback[0].id, feedback.id);
    return JSON.stringify({
      decisions: [],
      feedbackDecisions: [
        {
          id: feedback.id,
          action: "revise",
          reason: "New verified condition",
          expectedVersion: 1,
          content: "Deploy requires a health check with retry.",
          summary: "Health check and retry",
        },
      ],
    });
  });
  const updated = s.getArtifact(actor("b"), ref.id);
  assert.equal(updated.version, 2);
  assert.match(updated.content, /retry/);
  assert.equal(s.getArtifact(actor("b"), ref.id, 1).content, input().content);
  const resolved = s.listFeedback(actor("super"))[0];
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.resolvedArtifact, { ...ref, version: 2 });
  assert.equal(updated.evidenceRefs.length, 2);
  assert.deepEqual(updated.derivedFrom, [ref]);
  db.close();
});
test("reference feedback forks curated knowledge without changing origin [AC:bot-daydream-knowledge#AC-4]", () => {
  const { s, db } = setup();
  s.savePolicy({ ...actor("super"), admin: true }, policy);
  const sub = s.submit(actor("a"), input());
  const pub = s.decide(
    actor("super"),
    s.startBatch(actor("super")).id,
    sub.id,
    { action: "publish", reason: "valid" },
  );
  const ref = pub.publishedArtifact;
  const f = s.feedback(actor("b"), {
    artifactId: ref.id,
    artifactVersion: 1,
    kind: "correction",
    description: "Add retry",
    evidenceRefs: [{ sessionId: "b", messageId: "e", observedAt: "now" }],
  });
  const result = s.decideFeedback(
    actor("super"),
    s.startBatch(actor("super")).id,
    f.id,
    {
      action: "revise",
      reason: "Verified correction",
      expectedVersion: 1,
      content: "Check with retry.",
      summary: "Retry",
    },
  );
  assert.notEqual(result.resolvedArtifact.id, ref.id);
  assert.equal(s.getArtifact(actor("b"), ref.id).content, input().content);
  assert.equal(
    s.getArtifact(actor("b"), result.resolvedArtifact.id).publicationMode,
    "curated",
  );
  db.close();
});
test("late feedback, stale version and withdrawn evidence cannot revise [AC:bot-daydream-knowledge#AC-3] [AC:bot-daydream-knowledge#AC-5]", () => {
  const { s, deps, db } = setup();
  s.savePolicy({ ...actor("super"), admin: true }, policy);
  const sub = s.submit(actor("a"), { ...input(), publicationMode: "curated" });
  const pub = s.decide(
    actor("super"),
    s.startBatch(actor("super")).id,
    sub.id,
    { action: "publish", reason: "valid" },
  );
  const ref = pub.publishedArtifact;
  const early = s.startBatch(actor("super"));
  const f = s.feedback(actor("b"), {
    artifactId: ref.id,
    artifactVersion: 1,
    kind: "extension",
    description: "Add retry",
    evidenceRefs: [{ sessionId: "b", messageId: "e", observedAt: "now" }],
  });
  const decision = {
    action: "revise",
    reason: "Verified",
    expectedVersion: 1,
    content: "Check with retry.",
    summary: "Retry",
  };
  assert.throws(
    () => s.decideFeedback(actor("super"), early.id, f.id, decision),
    /outside batch/,
  );
  const batch = s.startBatch(actor("super"));
  assert.throws(
    () =>
      s.decideFeedback(actor("super"), batch.id, f.id, {
        ...decision,
        expectedVersion: 0,
      }),
    /version conflict/,
  );
  deps.validateEvidence = () => false;
  assert.throws(
    () => s.decideFeedback(actor("super"), batch.id, f.id, decision),
    /evidence access denied/,
  );
  assert.equal(s.listFeedback(actor("super"))[0].status, "pending");
  assert.equal(s.getArtifact(actor("b"), ref.id).version, 1);
  db.close();
});
test("pending unconfigured scope resolves only after explicit sharing policy [AC:bot-daydream-knowledge#AC-1] [AC:bot-daydream-knowledge#AC-2]", () => {
  const { s, db } = setup();
  const pending = s.submit(actor("a"), { ...input(), recipientBotIds: [] });
  assert.equal(pending.awaitingScope, true);
  s.savePolicy({ ...actor("super"), admin: true }, policy);
  const out = s.decide(
    actor("super"),
    s.startBatch(actor("super")).id,
    pending.id,
    { action: "publish", reason: "Authorized policy now configured" },
  );
  assert.deepEqual(out.recipientBotIds, ["b"]);
  assert.equal(
    s.getArtifact(actor("b"), out.publishedArtifact.id).content,
    input().content,
  );
  assert.equal(s.listArtifacts(actor("c")).length, 0);
  s.clearPolicy({ ...actor("super"), admin: true });
  assert.equal(s.getPolicy(actor("a")), null);
  assert.equal(s.listSubmissions(actor("a")).length, 1);
  db.close();
});
test("review policy runs Super analysis but waits for human publication [AC:bot-daydream-knowledge#AC-3]", async () => {
  const { s, db } = setup();
  s.savePolicy(
    { ...actor("super"), admin: true },
    { ...policy, publishPolicy: "review" },
  );
  const candidate = s.submit(actor("a"), input());
  let calls = 0;
  const complete = async () => {
    calls++;
    return JSON.stringify({
      decisions: [
        {
          id: candidate.id,
          action: "publish",
          reason: "Verified but needs approval",
        },
      ],
    });
  };
  const reviewed = await s.govern(actor("super"), complete);
  assert.equal(reviewed[0].status, "pending");
  assert.equal(reviewed[0].reviewDecision.action, "publish");
  assert.equal(s.listArtifacts(actor("b")).length, 0);
  await s.govern(actor("super"), complete);
  assert.equal(calls, 1);
  const accepted = s.decide(
    { ...actor("super"), admin: true },
    s.startBatch(actor("super")).id,
    candidate.id,
    reviewed[0].reviewDecision,
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(s.listArtifacts(actor("b")).length, 1);
  db.close();
});
