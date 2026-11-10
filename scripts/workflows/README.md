# Local workflow material collector

These files maintain the collector installed under `~/.local/share/agent-home-workflows/`.
Copy `material-source.mjs`, `material-source-isolation.mjs` and `cube-transition.mjs` together; the installation's `workflows.json`, output files and private runtime data remain outside Git.

`node material-source.mjs --materials-only` updates input materials without posting review requests or conclusions to rooms. The scheduled invocation without that argument retains its existing review workflow. Each independent target update reports its own failure and allows later targets to continue.

Regression: `node --test scripts/workflows/material-source-isolation.test.mjs`.
