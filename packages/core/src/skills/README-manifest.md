# Skill Manifest vs progressive disclosure

| Concern | Module | Role |
| --- | --- | --- |
| Content loading | `skill-disclosure.ts`, `runtime/skill-load.ts` | How much SKILL.md body is injected (lazy / progressive). |
| Capability boundary | `skill-manifest.ts` | What the skill may do: tools, paths, network, secret *names*. |

They are orthogonal. A skill can be progressively disclosed **and** constrained by a Manifest.
Invalid Manifest fails closed (skill load / registry parse rejects it).
Enforcement helpers (`enforceSkillManifest`) are consulted when a skill is active.

Sources (sibling JSON preferred when present; else frontmatter):

1. Sibling `skill.manifest.json` or `capability.json` next to SKILL.md
2. Frontmatter key `capability` or `manifest` (object or JSON string)

Builtin example: Planning carries `PLANNING_SKILL_MANIFEST` (todo tools only, network none).
