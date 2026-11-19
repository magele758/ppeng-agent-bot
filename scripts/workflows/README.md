# Local workflow material collector

These files maintain the collector installed under `~/.local/share/agent-home-workflows/`.
Build core first. Copy `material-source.mjs`, `material-source-isolation.mjs` and `cube-transition.mjs` together, and install `command-env.mjs` with its export pointing to the owning installation’s built `packages/core/dist/sandbox/env-sanitizer.js`; the installation's `workflows.json`, output files and private runtime data remain outside Git.

The CubeSandbox probe reads its hosts from that `workflows.json`: `cube.jumpHost` (SSH alias of the jump host), `cube.healthUrl` (service health URL), `cube.pingPrefix` (address prefix) and `cube.pingHosts` (address suffixes, service host first, then its neighbours). Without them only that target fails.

`node material-source.mjs --materials-only` updates input materials without posting review requests or conclusions to rooms. The scheduled invocation without that argument retains its existing review workflow. Each independent target update reports its own failure and allows later targets to continue.

Regression: `node --test scripts/workflows/material-source-isolation.test.mjs`.
