// Print structural events with source line numbers. Keep untrusted free text out of reports.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const input = process.argv[2];
if (!input) throw new Error('Usage: node timeline.mjs <events.jsonl>');
let line = 0;
for await (const raw of createInterface({input:createReadStream(input), crlfDelay:Infinity})) {
  line++;
  if (!raw.trim()) continue;
  try {
    const {ts,kind,payload} = JSON.parse(raw);
    if (!Number.isFinite(Date.parse(ts)) || !/^[a-z][a-z0-9_]{0,63}$/.test(kind)) throw new Error();
    const row = {line, ts:new Date(ts).toISOString(), kind};
    for (const key of ['turn','durationMs']) {
      if (Number.isFinite(payload?.[key])) row[key] = payload[key];
    }
    for (const key of ['terminal','ok','truncated']) {
      if (typeof payload?.[key] === 'boolean') row[key] = payload[key];
    }
    console.log(JSON.stringify(row));
  } catch {
    console.log(JSON.stringify({line,kind:'invalid_record'}));
  }
}
