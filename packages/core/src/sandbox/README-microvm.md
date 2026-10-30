# remote_vm ↔ agent-sandbox-microvm

## Lifecycle (control plane)

Point `MICROVM_URL` at the in-house control plane (Ubuntu1 lab: `:18081`).

```sh
export MICROVM_URL=http://100.108.223.41:18081
export MICROVM_API_KEY=e2b_devkey          # or BOOTSTRAP_API_KEY
export MICROVM_INTERNAL_TOKEN=dev-internal-token  # for guest route lookup
node --import tsx packages/core/scripts/microvm-smoke.mjs
# or: create → GET guest /health → DELETE via smokeMicrovmLifecycle()
```

Smoke evidence expected: create HTTP 201 (`sbx_…`), guest `/health` 200 `{"status":"ok"}`, delete HTTP 204.

Guest `/health` is on the microVM private IP (e.g. `172.16.0.x:49983`) and is reachable from the Ubuntu1 node host; remote callers need edge or host-local smoke.


## `/exec` (command adapter)

`RemoteVmAgentSandbox` speaks `POST {base}/exec` with
`{ command, cwd, workspace, timeoutMs, allowNetwork, sessionId }` →
`{ stdout, stderr, code }`.

### URL resolution

1. `MICROVM_URL`
2. Else `RAW_AGENT_SANDBOX_MICROVM_URL` (or `RAW_AGENT_AGENT_SANDBOX_MICROVM_URL`)
3. Else `RAW_AGENT_SANDBOX_REMOTE_URL` when `RAW_AGENT_SANDBOX_REMOTE_BACKEND=microvm`
4. Else plain `RAW_AGENT_SANDBOX_REMOTE_URL` (generic E2B-like adapter) — only when not demanding microVM

`RAW_AGENT_AGENT_SANDBOX_KIND=microvm` (or `agent-sandbox-microvm`) uses this remote path.
That kind does not fall back to a generic `RAW_AGENT_SANDBOX_REMOTE_URL` unless the backend is also marked microvm.
If the URL is missing, `/exec` is unreachable, or the body has no numeric `code`, the command fails and is not run on the host.

Final acceptance by lei pending.
