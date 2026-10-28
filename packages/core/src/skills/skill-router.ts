/**
 * SkillRouter: routing orchestration and environment configuration.
 * Lexical matching, scoring, and relationship computation live in ./skill-matcher.ts.
 *
 * 改造前/后对照与 env 说明见仓库 `doc/skill-router-baseline.md`.
 */
import { setImmediate as yieldToIO } from 'node:timers/promises';
import type { SkillSpec } from '../types.js';
import { matchSkills } from './builtin-skills.js';
import {
  assessRoutingConfidence,
  assessRoutingConfidenceWithRobustness,
  buildSkillRelationshipCache,
  computeParticleRobustness,
  needsRebuild,
  routeSkillsLexical,
  routeSkillsWithFusion,
  tokenize,
  uniqueTokens,
  type RoutedSkill,
  type RoutingConfidenceInfo,
  type SkillRelationshipCache,
} from './skill-matcher.js';

export type SkillRoutingMode = 'legacy' | 'lexical' | 'hybrid';

function normalizeEnvMode(raw: string | undefined): SkillRoutingMode {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'legacy' || v === 'lexical' || v === 'hybrid') {
    return v;
  }
  return 'hybrid';
}

/** 路由模式：legacy=旧行为；lexical=仅全文词法 shortlist；hybrid=词法 shortlist ∪ trigger 命中 */
export function skillRoutingModeFromEnv(env: NodeJS.ProcessEnv = process.env): SkillRoutingMode {
  return normalizeEnvMode(env.RAW_AGENT_SKILL_ROUTING_MODE);
}

export function skillRoutingTopKFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.RAW_AGENT_SKILL_ROUTING_TOP_K);
  if (Number.isFinite(v) && v >= 1) {
    return Math.min(50, Math.floor(v));
  }
  return 8;
}

/** load_skill 是否仅允许当前轮的 routing shortlist（lexical/hybrid）；legacy 下不限制 */
export function skillLoadStrictFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.RAW_AGENT_SKILL_LOAD_STRICT ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Whether to use FusionRAG-style context fusion for skill routing. Default: false. */
export function skillRoutingFusionFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.RAW_AGENT_SKILL_ROUTING_FUSION ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

// ── Exported types ─────────────────────────────────────────────────────────────

export interface SkillRoutingResult {
  mode: SkillRoutingMode;
  shortlistNames: string[];
  routed: RoutedSkill[];
  keywordMatched: SkillSpec[];
  /** Confidence assessment for routing quality */
  confidence: RoutingConfidenceInfo;
  /** Optional: relationship cache used for fusion (when fusion mode is active) */
  relationshipCache?: SkillRelationshipCache;
}

/** Extended options for skill routing with fusion support. */
export interface SkillRoutingOptions {
  mode: SkillRoutingMode;
  topK: number;
  /** Enable FusionRAG-style context fusion. Default: false for backward compatibility. */
  useFusion?: boolean;
  /** Pre-existing relationship cache (will be rebuilt if stale). */
  relationshipCache?: SkillRelationshipCache | null;
}

/**
 * Extended options for skill routing with particle-based robustness.
 */
export interface RobustRoutingOptions {
  mode: SkillRoutingMode;
  topK: number;
  /** Enable particle-based robustness computation (default: false for backward compatibility) */
  computeRobustness?: boolean;
  /** Number of particles for robustness estimation (default: 5) */
  particleCount?: number;
}

/**
 * Tool-quality-aware routing options.
 * Integrates ToolDiscoveryProtocol performance learning with skill routing.
 */
export interface ToolAwareRoutingOptions {
  mode: SkillRoutingMode;
  topK: number;
  /** Tool discovery protocol instance with learned performance metrics. */
  toolDiscovery?: import('../tools/tool-discovery.js').ToolDiscoveryProtocol;
  /** Weight for tool quality in final score (0-1, default: 0.15). */
  qualityWeight?: number;
}

// ── Exported routing functions ─────────────────────────────────────────────────

export function buildSkillRouting(
  userText: string,
  allSkills: SkillSpec[],
  options: { mode: SkillRoutingMode; topK: number }
): SkillRoutingResult {
  const { mode, topK } = options;

  if (mode === 'legacy') {
    const keywordMatched = matchSkills(userText, allSkills);
    const legacyConfidence: RoutingConfidenceInfo = keywordMatched.length > 0
      ? {
          level: 'high',
          scoreGap: 0,
          nearTopCount: keywordMatched.length,
          reason: `legacy keyword match: ${keywordMatched.length} skill(s) triggered`
        }
      : {
          level: 'low',
          scoreGap: 0,
          nearTopCount: 0,
          reason: 'legacy mode: no keyword matches'
        };
    return {
      mode,
      shortlistNames: allSkills.map((s) => s.name),
      routed: [],
      keywordMatched,
      confidence: legacyConfidence
    };
  }

  return finishSkillRouting(userText, allSkills, mode, routeSkillsLexical(userText, allSkills, topK));
}

function finishSkillRouting(userText: string, allSkills: SkillSpec[], mode: SkillRoutingMode, routed: RoutedSkill[]): SkillRoutingResult {
  const keywordMatched = mode === 'hybrid' ? matchSkills(userText, allSkills) : [];
  const confidence = assessRoutingConfidence(routed);
  const nameSet = new Set<string>();
  for (const r of routed) {
    nameSet.add(r.skill.name);
  }
  for (const s of keywordMatched) {
    nameSet.add(s.name);
  }
  const shortlistNames = [...nameSet];

  return {
    mode,
    shortlistNames,
    routed,
    keywordMatched,
    confidence
  };
}

/**
 * Build skill routing with optional FusionRAG-style context fusion.
 * When fusion is enabled, related skills receive a context boost based on
 * precomputed relationships, addressing the cross-context matching problem.
 */
export function buildSkillRoutingWithFusion(
  userText: string,
  allSkills: SkillSpec[],
  options: SkillRoutingOptions
): SkillRoutingResult {
  const { mode, topK, useFusion = false, relationshipCache = null } = options;

  if (mode === 'legacy') {
    const keywordMatched = matchSkills(userText, allSkills);
    const legacyConfidence: RoutingConfidenceInfo = keywordMatched.length > 0
      ? {
          level: 'high',
          scoreGap: 0,
          nearTopCount: keywordMatched.length,
          reason: `legacy keyword match: ${keywordMatched.length} skill(s) triggered`
        }
      : {
          level: 'low',
          scoreGap: 0,
          nearTopCount: 0,
          reason: 'legacy mode: no keyword matches'
        };
    return {
      mode,
      shortlistNames: allSkills.map((s) => s.name),
      routed: [],
      keywordMatched,
      confidence: legacyConfidence
    };
  }

  const keywordMatched = mode === 'hybrid' ? matchSkills(userText, allSkills) : [];

  // Use fusion routing if enabled
  let cache = relationshipCache;
  let routed: RoutedSkill[];

  if (useFusion) {
    // Rebuild cache if needed
    if (needsRebuild(cache, allSkills)) {
      cache = buildSkillRelationshipCache(allSkills);
    }
    routed = routeSkillsWithFusion(userText, allSkills, cache!, topK);
  } else {
    routed = routeSkillsLexical(userText, allSkills, topK);
  }

  const confidence = assessRoutingConfidence(routed);
  const nameSet = new Set<string>();
  for (const r of routed) {
    nameSet.add(r.skill.name);
  }
  for (const s of keywordMatched) {
    nameSet.add(s.name);
  }
  const shortlistNames = [...nameSet];

  return {
    mode,
    shortlistNames,
    routed,
    keywordMatched,
    confidence,
    relationshipCache: useFusion ? cache! : undefined
  };
}

/**
 * Build skill routing with particle-based robustness estimation.
 * Inspired by arXiv:2603.01122 - confidence-aware prediction via particle filtering.
 *
 * This function extends the standard routing with robustness scoring:
 * - Generates query perturbations (particles) to test routing stability
 * - Computes robustness score (0-1) based on consistency across particles
 * - Adjusts confidence level based on robustness
 *
 * Use this when you need higher confidence in routing decisions, especially
 * for ambiguous queries or when the cost of a wrong match is high.
 */
export function buildSkillRoutingWithRobustness(
  userText: string,
  allSkills: SkillSpec[],
  options: RobustRoutingOptions
): SkillRoutingResult {
  const { mode, topK, computeRobustness = false, particleCount = 5 } = options;

  // Get base routing result
  const baseResult = buildSkillRouting(userText, allSkills, { mode, topK });

  // Add robustness computation if requested
  if (computeRobustness && mode !== 'legacy' && baseResult.routed.length > 0) {
    const enhancedConfidence = assessRoutingConfidenceWithRobustness(
      baseResult.routed,
      userText,
      allSkills,
      { particleCount }
    );

    return {
      ...baseResult,
      confidence: enhancedConfidence
    };
  }

  return baseResult;
}

/**
 * Route skills with tool performance quality factored into rankings.
 *
 * This integrates the ToolDiscoveryProtocol with skill routing, allowing
 * skills associated with better-performing tools to receive a quality boost.
 *
 * The quality boost is computed from:
 * 1. Token matching between query and learned token-quality patterns
 * 2. Overall tool reliability (confidence-weighted)
 *
 * @param userText - The user's query text
 * @param allSkills - All available skills
 * @param options - Routing options including tool discovery instance
 */
export function buildSkillRoutingWithToolQuality(
  userText: string,
  allSkills: SkillSpec[],
  options: ToolAwareRoutingOptions
): SkillRoutingResult {
  const { mode, topK, toolDiscovery, qualityWeight = 0.15 } = options;

  // Get base routing result
  const baseResult = buildSkillRouting(userText, allSkills, { mode, topK });

  // If no tool discovery or no routed skills, return base result
  if (!toolDiscovery || baseResult.routed.length === 0) {
    return baseResult;
  }

  // Extract query tokens for quality matching
  const queryTokens = uniqueTokens(tokenize(userText));

  // Apply quality boost to routed skills
  const qualityBoosts = new Map<string, { boost: number; quality: number; confidence: number }>();

  for (const routed of baseResult.routed) {
    // Get quality estimate for this skill's tools
    const estimate = toolDiscovery.estimateQuality(routed.skill.name, queryTokens);

    if (estimate.confidence > 0) {
      // Compute boost proportional to quality and confidence
      // Higher confidence = more weight on the quality score
      const boost = estimate.quality * estimate.confidence * qualityWeight * 10;
      qualityBoosts.set(routed.skill.name, {
        boost: Math.round(boost * 10) / 10,
        quality: estimate.quality,
        confidence: estimate.confidence
      });
    }
  }

  // Apply boosts and re-sort
  const enhancedRouted = baseResult.routed.map(routed => {
    const boost = qualityBoosts.get(routed.skill.name);
    if (!boost) return routed;

    const newScore = routed.score + boost.boost;
    const qualityNote = `tool-quality:+${boost.boost.toFixed(1)} (${(boost.quality * 100).toFixed(0)}% @ ${(boost.confidence * 100).toFixed(0)}% conf)`;

    return {
      skill: routed.skill,
      score: Math.round(newScore * 10) / 10,
      reason: routed.reason.includes('tool-quality')
        ? routed.reason
        : `${routed.reason}; ${qualityNote}`
    };
  });

  // Re-sort after applying quality boosts
  enhancedRouted.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  // Recompute confidence after quality adjustments
  const enhancedConfidence = assessRoutingConfidence(enhancedRouted);

  return {
    ...baseResult,
    routed: enhancedRouted,
    confidence: {
      ...enhancedConfidence,
      reason: enhancedConfidence.reason + (qualityBoosts.size > 0
        ? `; ${qualityBoosts.size} skill(s) boosted by tool quality`
        : '')
    }
  };
}

/**
 * Runtime routing yields between bounded catalog batches so cold lexical scans
 * cannot monopolize the daemon's HTTP event loop. Every skill is still scored.
 */
export async function buildSkillRoutingCooperative(
  userText: string,
  allSkills: SkillSpec[],
  options: SkillRoutingOptions
): Promise<SkillRoutingResult> {
  if (options.useFusion) {
    await yieldToIO();
    return buildSkillRoutingWithFusion(userText, allSkills, options);
  }
  const { mode, topK } = options;
  if (mode === 'legacy' || !userText.trim() || !Number.isFinite(topK) || topK < 1) {
    return buildSkillRouting(userText, allSkills, options);
  }
  const ranked: RoutedSkill[] = [];
  for (let offset = 0; offset < allSkills.length; offset += 16) {
    await yieldToIO();
    ranked.push(...routeSkillsLexical(userText, allSkills.slice(offset, offset + 16), topK));
  }
  ranked.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return finishSkillRouting(userText, allSkills, mode, ranked.slice(0, topK));
}
