---
name: site-playbooks
description: Browser navigate / site playbook workflow. Load before browser_navigate. Follow the matching site playbook steps; no silent bypass of playbooks or the mandatory skill gate.
triggerWords:
  - site-playbooks
  - site playbook
  - browser_navigate
  - playbook
  - navigate
aliases:
  - site-playbook
  - browser-navigate
---

# Site playbooks (mandatory skill)

Load this skill with `load_skill(site-playbooks)` before calling `browser_navigate`. The mandatory skill gate fail-closes that tool until this skill is loaded.

## When a browser navigate need is discovered

Follow this order. Do **not** invent a Grok/Canvas-style browse UI, and do **not** silently skip playbooks.

1. **Load this skill** — call `load_skill(site-playbooks)` first so the gate opens.
2. **Follow playbook steps** — if a site playbook applies to the host/path, follow its steps (search, open listing, read fields, cart rules, etc.) instead of ad-hoc clicking.
3. **Navigate** — only then call `browser_navigate` (still subject to Auto-review and any URL refuse policy).
4. **No silent bypass** — do not navigate around a required playbook step, and do not pretend the gate does not apply.

## Hard rules

- Always `load_skill(site-playbooks)` before `browser_navigate`.
- Follow playbook steps when a playbook exists for the target; no silent bypass.
- This Option A knife does **not** ship a full host→playbook library (Option B is out of scope).
- Unrestricted shell is forbidden from this skill.
- After load, `browser_navigate` may run, but Auto-review and any active Manifest `allowTools` ceiling still apply.
