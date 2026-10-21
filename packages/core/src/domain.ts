/**
 * Domain bundle: a packageable unit of domain-specific agents, tools, and
 * skills (e.g. SRE on-call, stock analyst). Mounted on top of the core
 * runtime via RuntimeOptions.extraAgents / extraTools / extraSkills.
 *
 * Bundles are intentionally just plain data — no DI container, no plugin
 * loader. The daemon static-imports the bundles it wants and concatenates
 * them; third-party packages can ship the same shape and be wired the same
 * way without touching core.
 *
 * `mergeDomainBundles` deduplicates by `agent.id` / `tool.name` so two
 * bundles registering the same identifier don't blow up at runtime — the
 * first registration wins and a caller that needs an override should drop
 * the conflicting bundle from the load list.
 */

import { withOnDemandDisclosure } from './tools/deferred-disclosure.js';
import type { AgentSpec, SkillSpec, ToolContract } from './types.js';

export interface DomainBundle {
  /** Stable identifier (e.g. "sre" / "stock"); also defaults agent.domainId. */
  id: string;
  /** Human-readable label used in UI grouping (e.g. "SRE Agent"). */
  label: string;
  /** Personas exposed by this bundle. domainId defaults to bundle.id. */
  agents: AgentSpec[];
  /** Tools registered with the runtime when this bundle is mounted. */
  tools: ToolContract<any>[];
  /** Optional skills appended to the prompt-router pool. */
  skills?: SkillSpec[];
}

export interface MergedDomainBundles {
  agents: AgentSpec[];
  tools: ToolContract<any>[];
  skills: SkillSpec[];
}

export function mergeDomainBundles(bundles: DomainBundle[]): MergedDomainBundles {
  const agents: AgentSpec[] = [];
  const tools: ToolContract<any>[] = [];
  const skills: SkillSpec[] = [];
  const seenAgentIds = new Set<string>();
  const seenToolNames = new Set<string>();
  const seenSkillNames = new Set<string>();

  for (const b of bundles) {
    for (const a of b.agents) {
      if (seenAgentIds.has(a.id)) continue;
      seenAgentIds.add(a.id);
      // Default domainId to the bundle id so the UI can group personas
      // even when the bundle author forgot to set it explicitly.
      agents.push({ ...a, domainId: a.domainId ?? b.id });
    }
    for (const t of b.tools) {
      if (seenToolNames.has(t.name)) continue;
      seenToolNames.add(t.name);
      tools.push(withOnDemandDisclosure(t));
    }
    if (b.skills) {
      for (const s of b.skills) {
        if (seenSkillNames.has(s.name)) continue;
        seenSkillNames.add(s.name);
        skills.push(s);
      }
    }
  }

  return { agents, tools, skills };
}
