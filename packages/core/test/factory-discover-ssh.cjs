#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const env = process.env;
  const cmd = String(argv.at(-1) ?? "");
  const prefix = "python3 -I -c \"import base64;exec(base64.b64decode('";
  const suffix = "'))\"";
  const record = {
    argv,
    input,
    hasAuthToken: Object.prototype.hasOwnProperty.call(env, "RAW_AGENT_AUTH_TOKEN"),
    authToken: env.RAW_AGENT_AUTH_TOKEN ?? null,
    hasIdentityFlag:
      argv.includes("-i") || argv.some((arg) => String(arg).includes("IdentityFile")),
    commandOk: false,
  };
  const write = (code, stdout, stderr) => {
    record.pythonStdout = stdout ?? "";
    record.pythonStderr = stderr ?? "";
    if (env.CAPTURE) fs.writeFileSync(env.CAPTURE, JSON.stringify(record));
    if (stdout) process.stdout.write(stdout);
    process.exit(code);
  };
  if (!cmd.startsWith(prefix) || !cmd.endsWith(suffix)) write(1, "", "unexpected command\n");
  const b64 = cmd.slice(prefix.length, -suffix.length);
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) write(1, "", "unexpected program\n");
  record.commandOk = true;
  record.program = Buffer.from(b64, "base64").toString("utf8");
  const result = spawnSync("python3", ["-I", "-c", record.program], {
    input,
    encoding: "utf8",
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: env.DISCOVERY_HOME,
      LANG: "C.UTF-8",
    },
  });
  write(result.status === null ? 1 : result.status, result.stdout, result.stderr);
});
