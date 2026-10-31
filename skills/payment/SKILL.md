---
name: payment
description: Card / CVV payment workflow via secure_form and vault_fill. Load before secure_form/vault_fill when touching cardNumber/CVV/card. Secrets NEVER enter the model; separate from login Secure Form track.
triggerWords:
  - payment
  - card
  - cardNumber
  - CVV
  - cvv
aliases:
  - card
  - checkout-payment
---

# Payment (mandatory skill)

Load this skill with `load_skill(payment)` before `secure_form` or `vault_fill` when the call touches `cardNumber`, `CVV`, or `card`. The mandatory skill gate fail-closes those payment surfaces until this skill is loaded.

## When a card / payment need is discovered

1. **Separate from login** — this is payment, not credential login Secure Form. Do not route card entry through `collect_credentials` / `vault_get` login skill.
2. **Prefer vault_fill / secure_form** — fill card fields via vault refs or Secure Form so plaintext never reaches the model.
3. **Shopping overlap** — `vault_fill` still requires `shopping`; card-touching `vault_fill` requires both `shopping` and `payment`.

## Hard rules

- Secrets (**cardNumber**, **CVV**, full card) **NEVER** enter the model, tool args meant for the model, or the conversation transcript.
- Clearly separate from the login Secure Form track (payment vs credential login).
- No unrestricted shell.
- After load, payment tools may run, but Auto-review and any active Manifest `allowTools` ceiling still apply.
