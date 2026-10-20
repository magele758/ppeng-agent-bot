## Summary

<!-- What changed and why. -->

## Acceptance

<!-- See skills/acceptance-first/SKILL.md and doc/ACCEPTANCE_GATE.md. Write "n/a" for changes with no user-visible behaviour (refactor, docs, CI). -->

| Spec (`acceptance/<id>.yaml`) | Status in this PR | Criteria changed? |
|---|---|---|
| `<feature-id>` | draft / approved / implemented / retired | no / yes — re-confirmed by owner on … |

- [ ] Criteria were approved by the owner before implementation (draft specs: awaiting approval, no code yet)
- [ ] Every approved criterion has a test tagged `[AC:<feature-id>#<criterion-id>]`
- [ ] No criterion was deleted or weakened to make the gate pass (use `status: retired` + `retiredReason`)

Gate result (`pnpm test:acceptance`):

```
<paste the "Acceptance gate — …" summary line and any errors>
```

## Testing

<!-- Commands run and results. -->
