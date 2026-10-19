#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  verifyReleaseEvidence,
  readTrustedEvidenceKey,
} from "./evidence-files.mjs";
export { REQUIRED_GATES, assessReleaseEvidence } from "./evidence-contract.mjs";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const file = process.argv[2];
  if (!file) {
    console.error(
      "Usage: node scripts/bot-release/evidence.mjs <evidence-manifest.json>; missing evidence cannot authorize release.",
    );
    process.exitCode = 1;
  } else {
    try {
      const result = verifyReleaseEvidence(
        JSON.parse(readFileSync(file, "utf8")),
        { root: dirname(resolve(file)), trustedKey: readTrustedEvidenceKey() },
      );
      console.log(JSON.stringify(result, null, 2));
      if (!result.ready) process.exitCode = 1;
    } catch (error) {
      console.error(
        "Evidence assessment failed; inspect the private manifest and trusted evidence configuration.",
      );
      process.exitCode = 1;
    }
  }
}
