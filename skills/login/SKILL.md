---
name: login
description: Sign-in / credential collection workflow. Load before collect_credentials or vault_get. Prefer UserVault list then Secure Form fill-from-vault (vaultEntryId/entryId); never put plaintext secrets in the model or conversation. Separate from browser vault_fill.
triggerWords:
  - login
  - sign-in
  - sign in
  - credentials
  - password
  - vault_get
  - collect_credentials
aliases:
  - sign-in
  - credentials
---

# Login (mandatory skill)

Load this skill with `load_skill(login)` before calling `collect_credentials` or `vault_get`. The mandatory skill gate fail-closes those tools until this skill is loaded.

## When a sign-in need is discovered

Follow this order. Do **not** invent a Grok/Canvas-style login UI.

1. **Vault list** — call `vault_list` to see saved UserVault login entries (ids/labels only; no secrets in the model).
2. **Secure Form fill-from-vault** — prefer Secure Form with `vaultEntryId` / `entryId` so fields map via receipt `fillRefs` without exposing plaintext (#371).
3. **Secure Form hand-fill** — if no suitable vault entry, present Secure Form for the user to type into the form UI (still no plaintext to the model).
4. **Handoff** — if Secure Form is unavailable or the user declines, hand off for the user to complete sign-in themselves.

## Hard rules

- Plaintext secrets **never** enter the model, tool args meant for the model, or the conversation transcript.
- This track is **not** browser `vault_fill` (commerce/checkout). Do not use `vault_fill` for product login.
- No real 1Password / external password-manager integration from this skill.
- After load, `collect_credentials` / `vault_get` may run, but Auto-review and any active Manifest `allowTools` ceiling still apply.
