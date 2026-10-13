# Bot software execution

Executable connections are granted per Bot and durable user/installation identity in Lab. Declared plugin tools require an explicit `executor` binding; an ordinary name/schema remains non-executable. Built-in CLI, browser and LCU tools retain their existing settings and approvals.

Supported executors:

- HTTP: GET/HEAD/OPTIONS and POST/PUT/PATCH/DELETE, primitive path/query/header parameters and JSON bodies. Credentials reference an existing environment/vault secret by `secretEnv` or `credRef: vault:NAME`; Bearer, header API key and query API key are supported. HTTP errors, cancellation, size limits and interrupted writes are visible in invocation history.
- OpenAPI 3.0/3.1: imports the subset above and resolves local references. Unsupported operations are listed with reasons. Recursive/remote references, complex parameter serialization, cookie parameters, OAuth, multiple alternative/combined authentication schemes, XML, multipart/binary requests and non-JSON responses are rejected. The importer does not claim full OpenAPI conformance.
- MCP: binds an already configured `mcp_invoke` or expanded `mcp_hN_*`/`mcp_sN_*` tool to a Bot. Existing MCP server credentials apply; host cancellation/timeout stops waiting and preserves an unknown outcome if an external action cannot be confirmed, rather than claiming rollback; per-binding credential overrides are rejected rather than pretending to work.

Connection health begins `configured`. HTTP probe performs a bounded HEAD request, validates address policy, and reports `ready` only on a successful response. MCP health becomes ready after a successful actual invocation; a mere transport hook is insufficient evidence of readiness. Tool errors mark the connection degraded.

A write that times out, receives an unconfirmed failure, or is interrupted remains `unknown`. Repeating the same request with another idempotency key does not automatically repeat that write. Invocation history exposes its stable ID and outcome. A human can reconcile an unknown invocation as completed or failed after checking the external software; the reconciliation requires a note and is not exposed as a model tool. Reusing an idempotency key with different arguments is rejected.

Network policy follows the existing private-host setting. Every HTTP redirect target is checked; cross-origin redirects and redirects for writes are refused so authorization is not forwarded elsewhere. Results are bounded and credential values are redacted. A revoked connection is checked again before dispatch, including a previously captured tool.

Connections use durable settings; invocation attempts use an indexed SQLite ledger with stable sequence pagination. Existing invocation settings migrate transactionally without truncating unknown or completed evidence. Deduplication and unresolved-write checks use indexed lookups rather than scanning displayed pages. A regression exercises more than 10,000 executor calls and verifies that an old unknown still blocks blind retries. Full 24-hour soak remains a separate release check.
