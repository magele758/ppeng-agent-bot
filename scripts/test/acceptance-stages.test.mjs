import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSpec,
  evaluateAcceptance,
} from "../acceptance/acceptance-lib.mjs";
import { compareAcceptance } from "../ci/base-revision.mjs";
const text = (stage) =>
  `id: field-proof\ntitle: Field proof\nstatus: approved\nverificationStage: ${stage}\nrequirement: Owner explicitly split local software and field acceptance\ncriteria:\n  - id: AC-1\n    given: Two real hosts exist\n    when: The real run completes\n    then: Keep real results\n`;
test("software stage preserves pending approved field criteria without calling them passing", () => {
  const p = parseSpec(text("deployment"), "field-proof.yaml");
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.warnings, []);
  const r = evaluateAcceptance({
    specs: [p.spec],
    staticTests: [],
    stage: "software",
  });
  assert.equal(r.ok, true);
  assert.equal(r.specs[0].ok, false);
  assert.equal(r.specs[0].applicable, false);
  assert.equal(r.specs[0].status, "approved");
  assert.equal(r.specs[0].criteria[0].state, "missing");
  assert.ok(r.notices.some((n) => n.includes("deployment")));
});
test("all-stage acceptance still fails absent field evidence and unknown stages fail closed", () => {
  const { spec } = parseSpec(text("deployment"), "field-proof.yaml");
  assert.equal(
    evaluateAcceptance({ specs: [spec], staticTests: [], stage: "all" }).ok,
    false,
  );
  assert.ok(parseSpec(text("ignore"), "field-proof.yaml").errors.length);
  assert.throws(() =>
    evaluateAcceptance({ specs: [], staticTests: [], stage: "ignore" }),
  );
});
test("already approved software requirements cannot silently move out of the software gate", () => {
  const { spec } = parseSpec(text("software"), "field-proof.yaml");
  assert.ok(
    compareAcceptance(
      [spec],
      [{ ...spec, verificationStage: "deployment" }],
    ).some((e) => e.includes("stage")),
  );
});
