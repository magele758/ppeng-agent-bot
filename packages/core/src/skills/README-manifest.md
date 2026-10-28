# Skill Manifest vs progressive disclosure

| Concern | Module | Role |
| --- | --- | --- |
| Content loading | `skill-disclosure.ts`, `runtime/skill-load.ts` | How much SKILL.md body is injected (lazy / progressive). |
| Capability boundary | `skill-manifest.ts` | What the skill may do: tools, paths, network, secret *names*. |

They are orthogonal. A skill can be progressively disclosed **and** constrained by a Manifest.
A missing manifest leaves the skill unrestricted. A present manifest is a ceiling: omitted tool or path allow-lists deny, and network defaults to none.
A broken sibling manifest skips that skill instead of loading it with no ceiling. Other skills in the tree still load.
After `load_skill`, the tool loop refuses later calls that exceed any active manifest (tools, paths, and network).
`load_skill` in a tool wave finishes before the other calls in that wave.
Shell tools are network-capable: with network `none` or an allow-list, a command is refused unless its host is on that list.

Sources (sibling JSON preferred when present; else frontmatter):

1. Sibling `skill.manifest.json` or `capability.json` next to SKILL.md
2. Frontmatter key `capability` or `manifest` (object or JSON string)

Builtin example: Planning carries `PLANNING_SKILL_MANIFEST` (todo tools only, network none).
