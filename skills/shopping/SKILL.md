---
name: shopping
description: Checkout / purchase browser and vault_fill workflow. Load before vault_fill or checkout-marked browser_click/browser_type. No plaintext secrets to the model; do not clone a Grok/Canvas commerce UI. Separate from login Secure Form track.
triggerWords:
  - shopping
  - checkout
  - purchase
  - vault_fill
  - buy
aliases:
  - checkout
  - purchase
---

# Shopping (mandatory skill)

Load this skill with `load_skill(shopping)` before `vault_fill` or checkout-marked `browser_click` / `browser_type`. The mandatory skill gate fail-closes those shopping surfaces until this skill is loaded.

## When a checkout / purchase need is discovered

Follow this order. Do **not** invent a Grok/Canvas-style shopping or commerce UI.

1. **Read this skill** — confirm the surface is shopping/checkout, not credential login.
2. **Dispatch** — use `vault_fill` for labeled checkout fields, or `browser_click` / `browser_type` only when the session/args mark checkout/purchase.
3. **Card fields** — if `vault_fill` refs touch `cardNumber` / `CVV`, also load `payment` first; payment is a separate mandatory skill.

## Hard rules

- Plaintext secrets **never** enter the model, tool args meant for the model, or the conversation transcript.
- This track is **not** login Secure Form (`collect_credentials` / `vault_get`). Do not use shopping tools for product sign-in.
- No Grok/Canvas commerce UI clone.
- After load, shopping tools may run, but Auto-review and any active Manifest `allowTools` ceiling still apply.
