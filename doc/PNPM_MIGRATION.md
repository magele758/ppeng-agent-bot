# pnpm installation and validation

This repository uses **pnpm 10.29.2** with **Node.js 22+**, including SQLite FTS5. Node remains the runtime. Bootstrap pnpm with Corepack; installations without Corepack can install the pinned pnpm CLI separately, then follow the same commands.

```sh
corepack enable
corepack prepare pnpm@10.29.2 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

`pnpm-workspace.yaml` defines `apps/*` and `packages/*`. Internal dependencies use `workspace:*` so a missing local package fails instead of downloading a same-named registry package. The only current dependency lock is `pnpm-lock.yaml`. Install scripts are enabled only for named native/build tools; do not enable all dependency scripts to bypass installation failures.

Package execution uses `pnpm run <script> [args]`, workspace selection uses `pnpm --filter <name> run <script> [args]`, and locally installed tools use `pnpm exec <tool>`. Unlike npm's script separator, additional `--` is usually unnecessary and would be forwarded to the script.

CI sets up pnpm before Node's pnpm cache, then installs with `--frozen-lockfile`. The current workspace never falls back to npm installation. Immutable historical checkout comparison chooses the installer from that checkout's lockfile. Snapshot generation resolves third-party tools from their declaring workspace and links internal packages to the historical checkout, preserving source isolation under pnpm's dependency layout.

Docker images install against the same frozen lock. The runtime image recreates its own production links; it does not borrow symlinks from the host. Desktop server bundles use pnpm's standalone production deployment tree. Existing self-heal configuration property names such as `customNpmScript`, and bootstrap override names such as `RAW_AGENT_NPM_BIN`, are retained for saved-client compatibility; the task executor is pnpm. If using that explicit bootstrap override, point it at the pnpm executable. No new environment switches are needed.

## npm publication and consumers

npm is still used for official registry authentication/OIDC/publication and for independent consumer verification. The published packages remain `@mage-ai-lab/api-types` and `@mage-ai-lab/agent-loop`. Their packed manifests replace internal workspace ranges with ordinary published versions; consumers can keep using npm. The check command validates artifacts without publishing:

```sh
pnpm test:package
```

## Regression

Use the existing gate entrypoints with pnpm. Preserve their checks and exit behavior:

```sh
pnpm test:unit
pnpm --filter @ppeng/agent-loop test
pnpm --filter @ppeng/agent-loop build
pnpm test:formal
pnpm test:package
pnpm test:integration
pnpm test:regression
pnpm test:e2e
pnpm test:acceptance
```

Cold/warm installation measurements and their limitations are recorded in `pnpm-install-benchmark.json`. Measurements compare frozen dependency resolutions with lifecycle scripts disabled equally for both installers; native-script functionality is verified separately. No speed ratio is assumed.


## Verified results (2026-10-20)

- All 15 owner-approved criteria implemented; criteria text unchanged. New migration contract tests were first run red before implementation.
- Frozen install and clean TypeScript build passed; no registry package versions were upgraded relative to the original npm lock. Root Next/React test dependencies and optional Playwright imports are now explicitly declared instead of depending on hoisting.
- Full unit run: **4454 tests, 4450 passed, 0 failed, 4 existing skips**. No new skips or weakened gates.
- Agent-loop SDK: **416/416 tests**, build and packaged skill synchronization passed.
- Full browser run: **206/206 passed**. A pre-existing cross-suite Bot roster exhaustion was exposed and fixed by sharing one dedicated reliability fixture and deleting its test routines; the product cap and all behavioral assertions remain unchanged.
- Formal regression passed, including bounded models, real runtime/process probes, isolated source mutation controls and reviewed source mappings. These checks retain their existing scope; bounded model results are not whole-system proofs.
- HTTP integration/regression, 22/22 fast eval cases, and paired experiment infrastructure checks passed. Simulation remains ineligible to authorize model promotion.
- Public tarball verification passed with an independent npm consumer: all exports, declaration resolution, mini static portability and a real mini session. Nothing was published.
- Both Docker images built from the final source and pinned `node:22.23.2-alpine`; isolated container checks passed for daemon health, Lab HTML, direct API 401, authenticated Lab proxy 200 and native Sharp image processing.
- Desktop production bundle: 673 internal links verified after moving the artifact outside the repository; its daemon booted successfully using Electron's Node runtime. Host desktop TypeScript build passed; this does not claim packaging every foreign operating system.
- Software acceptance static gate: **730/730**. Deployment-stage criteria remain separate.

Installation measurements are intentionally reported as measured: npm cold/warm about **71.4 s / 4.3 s**, pnpm cold/warm about **595.6 s / 3.1 s**. Cold pnpm was slower under heavy registry retries; warm pnpm was faster in this single trial. See the JSON for exact disk usage and limits. Do not interpret this as a general speed guarantee.

The host had Node 26 active; Electron's upstream installer exited without completing extraction under that runtime. Re-running the approved installer with the repository's Node 22 toolchain restored the binary; native execution and the relocated server smoke both passed. Use the checked-in `.nvmrc` for repeatable native installation.
