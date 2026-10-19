import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { SshFactoryTransport } from "../dist/factory/transport.js";
test("SSH publisher uses the fixed host program, a narrow request and sanitized child credentials [AC:multi-machine-controlled-delivery#AC-7]", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-publisher-wire-")),
    bin = join(root, "bin"),
    capture = join(root, "capture.json");
  mkdirSync(bin);
  const oldPath = process.env.PATH,
    oldKey = process.env.RAW_AGENT_API_KEY;
  process.env.PATH = bin + delimiter + oldPath;
  process.env.RAW_AGENT_API_KEY = "synthetic-upstream-key";
  writeFileSync(
    join(bin, "ssh"),
    '#!/usr/bin/env node\nconst fs=require("node:fs");let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{fs.writeFileSync(' +
      JSON.stringify(capture) +
      ',JSON.stringify({request:JSON.parse(input),argv:process.argv.slice(2),hasUpstreamKey:!!process.env.RAW_AGENT_API_KEY}));console.log(JSON.stringify({publisherError:"PublisherRefusal",publisherFinished:true,detail:"Privacy history size budget exceeded"}));});',
    { mode: 0o755 },
  );
  const transport = new SshFactoryTransport();
  t.after(async () => {
    await transport.close();
    process.env.PATH = oldPath;
    if (oldKey === undefined) delete process.env.RAW_AGENT_API_KEY;
    else process.env.RAW_AGENT_API_KEY = oldKey;
    rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(
    transport.delivery(
      { id: "host", sshAlias: "ubuntu", repositories: [] },
      {
        action: "artifact",
        taskId: "factory_wire",
        sha: "a".repeat(40),
        branch: "factory/factory_wire",
        policy: { credentialRef: "host-reference" },
      },
    ),
    (error) =>
      error.publisherFinished === true &&
      error.publisherRefused === true &&
      error.action === "artifact",
  );
  const observed = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(observed.request.action, "artifact");
  assert.equal(observed.request.policy.credentialRef, "host-reference");
  assert.equal(observed.hasUpstreamKey, false);
  assert.ok(!JSON.stringify(observed).includes("synthetic-upstream-key"));
  assert.ok(observed.argv.at(-1).startsWith("python3 -I -c"));
  assert.ok(!observed.argv.at(-1).includes("factory_wire"));
});
