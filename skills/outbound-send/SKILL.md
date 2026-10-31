---
name: outbound-send
description: Outbound social / IM send workflow. Load before schedule_social_post. Force Draft → Confirm → Send; may remind about style sampling; NEVER send without confirmation.
triggerWords:
  - outbound
  - send
  - schedule_social_post
  - post
  - publish
aliases:
  - outbound
  - social-post
---

# Outbound send (mandatory skill)

Load this skill with `load_skill(outbound-send)` before calling `schedule_social_post`. The mandatory skill gate fail-closes that tool until this skill is loaded.

## When an outbound post / send need is discovered

Force **Draft → Confirm → Send**. Never publish without an explicit confirmation step.

1. **Draft** — prepare the body/channels/publish time as a draft (approval stays draft / pending_approval).
2. **Confirm** — show the user what will send and as which identity; wait for confirmation.
3. **Send** — only after confirmation, approve / run the scheduled post.
4. **Style sampling** — you may remind the user about style sampling hints; do not silently rewrite the draft into a different voice.

## Hard rules

- **NEVER** send without confirmation.
- Do not bypass Draft → Confirm → Send.
- Unrestricted shell is forbidden from this skill.
- After load, `schedule_social_post` may run, but Auto-review and any active Manifest `allowTools` ceiling still apply.
