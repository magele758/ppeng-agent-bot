import test from "node:test";
import assert from "node:assert/strict";
import { zonedLocalToIso, zonedInstantToLocal } from "./routine-time.ts";
test("one-time schedule uses the selected zone and detects DST gaps [AC:bot-routine-lifecycle#AC-4]", () => {
  assert.equal(
    zonedLocalToIso("2026-10-13T09:00", "Asia/Shanghai"),
    "2026-10-13T01:00:00.000Z",
  );
  assert.equal(
    zonedLocalToIso("2026-11-01T01:30", "America/New_York"),
    "2026-11-01T05:30:00.000Z",
  );
  assert.equal(
    zonedLocalToIso("2026-10-25T02:30", "Europe/Berlin"),
    "2026-10-25T00:30:00.000Z",
  );
  assert.throws(
    () => zonedLocalToIso("2026-03-08T02:30", "America/New_York"),
    RangeError,
  );
});

test('editing preserves wall time in the schedule zone',()=>{assert.equal(zonedInstantToLocal('2026-10-13T01:00:00.000Z','Asia/Shanghai'),'2026-10-13T09:00');});
