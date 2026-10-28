# remote_vm ↔ agent-sandbox-microvm `/exec`

`RemoteVmAgentSandbox` speaks `POST {base}/exec` with
`{ command, cwd, workspace, timeoutMs, allowNetwork, sessionId }` →
`{ stdout, stderr, code }`.

## URL resolution

1. `RAW_AGENT_SANDBOX_MICROVM_URL` (or `RAW_AGENT_AGENT_SANDBOX_MICROVM_URL`)
2. Else `RAW_AGENT_SANDBOX_REMOTE_URL` when `RAW_AGENT_SANDBOX_REMOTE_BACKEND=microvm`
3. Else plain `RAW_AGENT_SANDBOX_REMOTE_URL` (generic E2B-like adapter)

## Virt blocker (4090 lab)

No in-tree Firecracker / cloud-hypervisor / `agent-sandbox-microvm` binary was
found under `/home/shinemo/penglei` at implementation time. Until the microVM
runtime is installed and its HTTP adapter is listening, use:

- a mock `/exec` server (see `packages/core/test/remote-vm-microvm-exec.test.js`)
- or point the URL at any compatible adapter

This keeps the mergeable interface + tests green without requiring virt on CI.

Final acceptance by lei pending.
