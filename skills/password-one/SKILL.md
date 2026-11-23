---
name: password-one
description: Blind credential broker workflow via Password One CLI (pw1:// handles). Run authenticated HTTP/CLI calls without ever handling plaintext secrets.
triggerWords:
  - password-one
  - pw1
  - pw1://
  - credential-broker
  - credential broker
  - blind http
  - blind exec
  - secret handle
  - api key
  - bearer token
aliases: [pw1, credential-broker]
---

# Password One (Blind Credential Broker)

Use Password One whenever an HTTP request or CLI command needs a secret credential. Credentials stay inside the broker and are injected strictly at the outbound boundary; responses are scrubbed across 6 encodings.

## Hard rules

- **NEVER** read, request, print, log, or echo plaintext secrets, API keys, or broker tokens (`PW1_BROKER_TOKEN`, `PW1_AUTH_TOKEN`).
- Pass **only** opaque handles (`pw1://<alias>` or `{{pw1://<alias>}}`) to the Password One CLI.
- Never inspect environment variables (`printenv`, `env`, `echo $...`) to discover credentials or tokens.

## 1. Handle discovery

If handle metadata is not already provided in context (for example via `PW1_HANDLE_HINTS`), list opaque handles and their bound policies (`allowedHosts`, `allowedTools`, `requireGrant`) first:

```bash
node "$PW1_CLI_PATH" handles
# or when installed on PATH:
pw1 handles
```

## 2. Blind HTTP request

Send authenticated HTTP requests through the broker using opaque handles only:

```bash
node "$PW1_CLI_PATH" http --url <url> --method <METHOD> --auth-bearer pw1://<alias>
```

Other supported options:

- Custom header (or placeholder): `--header "Name: Value"` / `--header "X-API-Key: {{pw1://alias}}"`
- Query parameter: `--query "k=v"`
- Named auth header: `--auth-header "<Header-Name>=pw1://<alias>"`
- HTTP Basic auth: `--auth-basic "<username>:pw1://<alias>"`
- Auth query parameter: `--auth-query "<param>=pw1://<alias>"`
- Request payload: `--body '<payload>'`

## 3. Blind CLI execution

Run allowlisted commands in Password One's clean-room environment (`execFile`, `shell: false`) with secret env bindings:

```bash
node "$PW1_CLI_PATH" exec --command <bin> --arg <arg1> --arg <arg2> --secret-env ENV_VAR=pw1://<alias>
```

## 4. Scrubbing & audit verification

- Scrub arbitrary third-party or tool output across 6 encodings:
  ```bash
  node "$PW1_CLI_PATH" scrub --text "<output>"
  ```
- Verify the SHA-256 hash-chained audit ledger:
  ```bash
  node "$PW1_CLI_PATH" audit-verify
  ```

## 5. Fail-closed policy & fallback rule

- If Password One returns `403 POLICY_VIOLATION` (such as a disallowed host, cross-origin `302` redirect theft, disallowed command, or invalid lease) or `409 POLICY_TAMPER_DETECTED`, treat it as a **hard security block**.
- **NEVER** attempt to bypass a policy block with `curl`, `wget`, direct HTTP scripts, or by reading environment variables. Stop and report the policy denial.
