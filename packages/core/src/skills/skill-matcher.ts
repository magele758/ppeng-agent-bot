/**
 * Skill matching and scoring primitives.
 * Lexical shortlist (name + description + body prefix), FusionRAG context fusion,
 * particle-based robustness, and holonomy-aware normalization.
 *
 * Extracted from skill-router.ts — this module handles low-level scoring;
 * see skill-router.ts for high-level routing orchestration.
 */
import type { SkillSpec } from '../types.js';

const BODY_SLICE = 24_000;

/** Minimum similarity threshold for skills to be considered related. */
const MIN_RELATIONSHIP_SCORE = 0.15;

/** Maximum number of related skills to track per skill. */
const MAX_RELATED_SKILLS = 5;

/** Maximum cycle length to detect for holonomy computation. */
const MAX_CYCLE_LENGTH = 4;

/** Minimum boost inflation ratio to trigger holonomy normalization. */
const HOLONOMY_INFLATION_THRESHOLD = 1.5;

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const parts = lower.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (p.length >= 2) {
      out.push(p);
    }
    if (/[\u4e00-\u9fff]/.test(p) && p.length === 1) {
      out.push(p);
    }
  }
  return out;
}

export function uniqueTokens(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

function normalizedSorted(values: string[] | undefined): string[] {
  if (!values) {
    return [];
  }
  return values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function skillRelationshipFingerprint(skill: SkillSpec): string {
  return [
    skill.id,
    skill.name,
    skill.description,
    (skill.content ?? '').slice(0, BODY_SLICE),
    normalizedSorted(skill.aliases).join(','),
    normalizedSorted(skill.triggerWords).join(',')
  ].join('\u001f');
}

/**
 * Represents a precomputed relationship between two skills.
 * Inspired by FusionRAG's cross-chunk context embedding.
 */
export interface SkillRelationship {
  /** Name of the related skill. */
  skillName: string;
  /** Similarity score (0-1) based on token overlap. */
  similarity: number;
  /** Shared tokens that indicate the relationship. */
  sharedTokens: string[];
}

/**
 * Precomputed skill relationships for context fusion.
 * This is the "offline preprocessing" phase inspired by FusionRAG.
 */
export interface SkillRelationshipCache {
  /** Map from skill name to its related skills. */
  relationships: Map<string, SkillRelationship[]>;
  /** Timestamp when the cache was built (for invalidation). */
  builtAt: number;
  /** Hash of routing-relevant skill metadata for cache validation. */
  skillHash: string;
  /** Detected cycles in the relationship graph (for holonomy detection). */
  cycles?: SkillCycle[];
}

/**
 * Represents a cycle in the skill relationship graph.
 * Inspired by the paper's "holonomy computation on the factor nerve" -
 * cycles can cause score inflation when skills mutually boost each other.
 */
export interface SkillCycle {
  /** Skills forming the cycle (in order). */
  nodes: string[];
  /** Product of edge similarities around the cycle. */
  holonomyScore: number;
  /** Whether this cycle causes significant score inflation. */
  isInflationary: boolean;
}

/**
 * Compute Jaccard-like similarity between two token sets.
 * Returns a score between 0 and 1.
 */
function computeTokenSimilarity(tokensA: Set<string>, tokensB: Set<string>): number {
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Extract tokens from a skill for relationship computation.
 * Uses name, description, trigger words, and body prefix.
 */
function extractSkillTokens(skill: SkillSpec): Set<string> {
  const tokens = new Set<string>();

  // Add name and description tokens
  const idTokens = tokenize(skill.id ?? '');
  const nameTokens = tokenize(skill.name ?? '');
  const aliasTokens = tokenize((skill.aliases ?? []).join(' '));
  const descTokens = tokenize(skill.description ?? '');
  const bodyTokens = tokenize((skill.content ?? '').slice(0, BODY_SLICE));

  for (const t of idTokens) tokens.add(t);
  for (const t of nameTokens) tokens.add(t);
  for (const t of aliasTokens) tokens.add(t);
  for (const t of descTokens) tokens.add(t);
  for (const t of bodyTokens) tokens.add(t);

  // Add trigger words (already normalized)
  if (skill.triggerWords) {
    for (const tw of skill.triggerWords) {
      const normalized = tw.toLowerCase().trim();
      if (normalized.length >= 2) tokens.add(normalized);
    }
  }

  return tokens;
}

/**
 * Build a relationship cache for all skills.
 * This is the "offline preprocessing" phase that embeds cross-skill context.
 * Also detects cycles in the relationship graph for holonomy-aware normalization.
 */
export function buildSkillRelationshipCache(skills: SkillSpec[]): SkillRelationshipCache {
  const relationships = new Map<string, SkillRelationship[]>();
  const skillTokens = new Map<string, Set<string>>();

  // Extract tokens for each skill
  for (const skill of skills) {
    const tokens = extractSkillTokens(skill);
    skillTokens.set(skill.name, tokens);
  }

  // Compute pairwise relationships
  for (const skillA of skills) {
    const tokensA = skillTokens.get(skillA.name)!;
    const related: SkillRelationship[] = [];

    for (const skillB of skills) {
      if (skillA.name === skillB.name) continue;

      const tokensB = skillTokens.get(skillB.name)!;
      const similarity = computeTokenSimilarity(tokensA, tokensB);

      if (similarity >= MIN_RELATIONSHIP_SCORE) {
        // Find shared tokens
        const sharedTokens: string[] = [];
        for (const t of tokensA) {
          if (tokensB.has(t)) sharedTokens.push(t);
        }

        related.push({
          skillName: skillB.name,
          similarity,
          sharedTokens: sharedTokens.slice(0, 10)
        });
      }
    }

    // Sort by similarity and keep top N
    related.sort((a, b) => b.similarity - a.similarity);
    relationships.set(skillA.name, related.slice(0, MAX_RELATED_SKILLS));
  }

  // Detect cycles for holonomy-aware normalization
  const cycles = detectSkillCycles(relationships);

  // Create hash for cache validation
  const skillHash = skills.map(skillRelationshipFingerprint).sort().join('\n');

  return {
    relationships,
    builtAt: Date.now(),
    skillHash,
    cycles
  };
}

/** Check if a relationship cache needs rebuilding. */
export function needsRebuild(cache: SkillRelationshipCache | null, currentSkills: SkillSpec[]): boolean {
  if (!cache) return true;
  const currentHash = currentSkills.map(skillRelationshipFingerprint).sort().join('\n');
  return cache.skillHash !== currentHash;
}

/**
 * Detect cycles in the skill relationship graph using DFS.
 * Inspired by the paper's "holonomy computation on the factor nerve" -
 * cycles represent potential score inflation paths where skills mutually boost each other.
 */
function detectSkillCycles(
  relationships: Map<string, SkillRelationship[]>,
  maxCycleLength: number = MAX_CYCLE_LENGTH
): SkillCycle[] {
  const cycles: SkillCycle[] = [];
  const visited = new Set<string>();
  const skillNames = Array.from(relationships.keys());

  function dfs(
    start: string,
    current: string,
    path: string[],
    pathSet: Set<string>,
    productSimilarity: number
  ): void {
    if (path.length > maxCycleLength) return;
    if (pathSet.has(current)) {
      // Found a cycle back to start
      if (current === start && path.length >= 3) {
        // Compute holonomy score: product of similarities around the cycle
        // High holonomy (> 0.1) means the cycle can cause significant score inflation
        cycles.push({
          nodes: [...path, current],
          holonomyScore: productSimilarity,
          isInflationary: productSimilarity > 0.1
        });
      }
      return;
    }

    const related = relationships.get(current) ?? [];
    for (const rel of related) {
      if (path.length === 1 && rel.skillName !== start) {
        // First step: only follow edges that could lead back to start
        pathSet.add(current);
        dfs(start, rel.skillName, [...path, current], pathSet, productSimilarity * rel.similarity);
        pathSet.delete(current);
      } else if (path.length > 1) {
        // Subsequent steps: can explore more freely
        pathSet.add(current);
        dfs(start, rel.skillName, [...path, current], pathSet, productSimilarity * rel.similarity);
        pathSet.delete(current);
      }
    }
  }

  // Start DFS from each skill to find cycles
  for (const name of skillNames) {
    if (!visited.has(name)) {
      dfs(name, name, [], new Set(), 1);
      visited.add(name);
    }
  }

  // Deduplicate cycles (same cycle starting from different nodes)
  const seenCycles = new Set<string>();
  return cycles.filter(cycle => {
    // Normalize cycle for comparison (start from smallest node)
    const normalized = normalizeCycle(cycle.nodes);
    const key = normalized.join('→');
    if (seenCycles.has(key)) return false;
    seenCycles.add(key);
    return true;
  });
}

/**
 * Normalize a cycle representation for deduplication.
 * Rotates the cycle to start from the lexicographically smallest node.
 */
function normalizeCycle(nodes: string[]): string[] {
  if (nodes.length === 0) return nodes;
  const inner = nodes.slice(0, -1); // Remove the repeated end node
  let minIdx = 0;
  for (let i = 1; i < inner.length; i++) {
    if (inner[i]! < inner[minIdx]!) minIdx = i;
  }
  // Rotate to start from minimum
  return [...inner.slice(minIdx), ...inner.slice(0, minIdx), inner[minIdx]!];
}

/**
 * Compute the holonomy correction factor for a skill based on detected cycles.
 * Skills involved in inflationary cycles receive a penalty proportional to
 * the holonomy score of the cycle.
 *
 * Inspired by the paper's insight that "non-trivial holonomy" indicates
 * inconsistencies that need to be "compiled into mode variables" for exact inference.
 */
function computeHolonomyCorrection(
  skillName: string,
  cycles: SkillCycle[]
): { correction: number; cycleCount: number } {
  let totalCorrection = 0;
  let cycleCount = 0;

  for (const cycle of cycles) {
    if (!cycle.isInflationary) continue;
    if (!cycle.nodes.includes(skillName)) continue;

    // Each inflationary cycle contributes a small penalty
    // The penalty increases with the number of cycles the skill participates in
    totalCorrection += cycle.holonomyScore * 0.5;
    cycleCount++;
  }

  // Normalize correction to avoid over-penalizing
  // Max correction is capped to prevent negative scores
  const correction = Math.min(totalCorrection, 10);

  return { correction, cycleCount };
}

interface LexicalDocument {
  source: string[];
  fields: string[];
  meta: string;
  tokenFields: Map<string, number>;
}
const lexicalDocuments = new WeakMap<SkillSpec, LexicalDocument>();
const LEXICAL_TOKEN_CACHE_LIMIT = 256;
const LEXICAL_TOKEN_CACHE_MAX_LENGTH = 128;
const lexicalWeights = [14, 12, 10, 6, 5, 2];
const lexicalLabels = ['name', 'alias', 'id', 'desc', 'trigger', 'body'];

function lexicalDocument(skill: SkillSpec): LexicalDocument {
  const source = [skill.name ?? '', (skill.aliases ?? []).join(' '), skill.id ?? '',
    skill.description ?? '', (skill.triggerWords ?? []).join(' '), (skill.content ?? '').slice(0, BODY_SLICE)];
  const cached = lexicalDocuments.get(skill);
  if (cached && source.every((value, i) => value === cached.source[i])) return cached;
  const fields = source.map(value => value.toLowerCase());
  const document = { source, fields, meta: fields.slice(0, 5).join(' '), tokenFields: new Map<string, number>() };
  lexicalDocuments.set(skill, document);
  return document;
}

/** Preserve substring semantics and highest-field weights; reuse repeated query tokens. */
function lexicalScoreForSkill(skill: SkillSpec, queryTokens: string[], fullQ: string): { score: number; hits: string[] } {
  const document = lexicalDocument(skill);
  let score = 0;
  const hits: string[] = [];
  for (const token of queryTokens) {
    if (!token) continue;
    let field = document.tokenFields.get(token);
    if (field === undefined) {
      field = document.fields.findIndex(text => text.includes(token));
      // Long input blobs must not grow a cache proportional to conversation size.
      if (token.length <= LEXICAL_TOKEN_CACHE_MAX_LENGTH) {
        if (document.tokenFields.size >= LEXICAL_TOKEN_CACHE_LIMIT) {
          document.tokenFields.delete(document.tokenFields.keys().next().value!);
        }
        document.tokenFields.set(token, field);
      }
    }
    if (field >= 0) {
      score += lexicalWeights[field]!;
      hits.push(`${lexicalLabels[field]}:${token}`);
    }
  }
  if (fullQ.length >= 4) {
    if (document.meta.includes(fullQ)) {
      score += 22;
      hits.push('phrase:meta');
    } else if (document.fields[5]!.includes(fullQ)) {
      score += 10;
      hits.push('phrase:body');
    }
  }
  return { score, hits };
}

export interface RoutedSkill {
  skill: SkillSpec;
  score: number;
  /** 简短命中说明，便于写进 system prompt */
  reason: string;
}

export type RoutingConfidence = 'high' | 'medium' | 'low';

export interface RoutingConfidenceInfo {
  level: RoutingConfidence;
  /** Score gap between top-1 and top-2 (0 if only one candidate) */
  scoreGap: number;
  /** Number of skills within 30% of top score */
  nearTopCount: number;
  /** Reason for confidence level */
  reason: string;
  /** Particle-based robustness score (0-1), inspired by GPU-accelerated Bayesian inference */
  robustness?: number;
}

/**
 * 基于 name + description + 正文前几万字符做轻量词法排序，返回 top-K。
 */
export function routeSkillsLexical(query: string, skills: SkillSpec[], topK: number): RoutedSkill[] {
  const q = query.trim();
  if (!q) {
    return skills.slice(0, topK).map((skill) => ({ skill, score: 0, reason: '(empty query)' }));
  }

  const queryTokens = uniqueTokens(tokenize(q));
  const fullQ = queryTokens.join(' ').trim();
  if (queryTokens.length === 0) {
    const lowerQ = q.toLowerCase();
    return skills
      .map((skill) => {
        const blob = `${skill.name} ${skill.description} ${(skill.content ?? '').slice(0, BODY_SLICE)}`.toLowerCase();
        const hit = blob.includes(lowerQ);
        return {
          skill,
          score: hit ? 5 : 0,
          reason: hit ? 'substring' : 'no-token-match'
        };
      })
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, topK);
  }

  const ranked = skills
    .map((skill) => {
      const { score, hits } = lexicalScoreForSkill(skill, queryTokens, fullQ);
      const reason = hits.length ? hits.slice(0, 6).join(', ') : 'no-hit';
      return { skill, score, reason };
    })
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  return ranked.slice(0, topK);
}

/**
 * Generate query perturbations (particles) for robustness estimation.
 * Inspired by particle-based Bayesian inference from arXiv:2603.01122.
 * Each particle represents a slight variation of the query to test stability.
 */
function generateQueryParticles(query: string, count: number = 5): string[] {
  const tokens = tokenize(query);
  if (tokens.length <= 1) {
    return [query]; // Cannot perturb single-token queries
  }

  const particles: string[] = [query]; // Always include original

  // Particle 1: Drop first token (test if first word is critical)
  if (tokens.length > 2) {
    particles.push(tokens.slice(1).join(' '));
  }

  // Particle 2: Drop last token
  if (tokens.length > 2) {
    particles.push(tokens.slice(0, -1).join(' '));
  }

  // Particle 3: Keep only high-value tokens (longer, more specific)
  const longTokens = tokens.filter(t => t.length >= 4);
  if (longTokens.length >= 1 && longTokens.length < tokens.length) {
    particles.push(longTokens.join(' '));
  }

  // Particle 4: Shuffle middle tokens (test order sensitivity)
  if (tokens.length >= 3) {
    const middle = tokens.slice(1, -1);
    for (let i = middle.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = middle[i];
      middle[i] = middle[j]!;
      if (temp !== undefined) middle[j] = temp;
    }
    particles.push([tokens[0]!, ...middle, tokens[tokens.length - 1]!].join(' '));
  }

  return particles.slice(0, count);
}

/**
 * Compute robustness score using particle-based variance estimation.
 * Inspired by arXiv:2603.01122 - particle filters for uncertainty quantification.
 *
 * A skill that consistently ranks high across query perturbations has high robustness.
 * Returns a score between 0 and 1, where 1 means the top skill is stable across all particles.
 */
export function computeParticleRobustness(
  query: string,
  skills: SkillSpec[],
  topK: number = 3
): { robustness: number; topSkillName: string; particleResults: Map<string, string[]> } {
  const particles = generateQueryParticles(query);
  const particleResults = new Map<string, string[]>();

  // Route each particle and collect top-K skill names
  for (const particle of particles) {
    const routed = routeSkillsLexical(particle, skills, topK);
    const names = routed.map(r => r.skill.name);
    particleResults.set(particle, names);
  }

  // Find the most consistent top skill across particles
  const topSkillCounts = new Map<string, number>();
  for (const [, names] of particleResults) {
    if (names.length > 0) {
      const top = names[0]!;
      topSkillCounts.set(top, (topSkillCounts.get(top) ?? 0) + 1);
    }
  }

  // Robustness = fraction of particles where top-1 is the same skill
  let maxCount = 0;
  let topSkillName = '';
  for (const [name, count] of topSkillCounts) {
    if (count > maxCount) {
      maxCount = count;
      topSkillName = name;
    }
  }

  const robustness = particles.length > 0 ? maxCount / particles.length : 0;

  return { robustness, topSkillName, particleResults };
}

/**
 * Assess confidence in routing result based on score distribution.
 * High confidence: clear winner with significant score gap
 * Medium confidence: top skill stands out but has close competitors
 * Low confidence: multiple skills with similar scores (ambiguous intent)
 */
export function assessRoutingConfidence(routed: RoutedSkill[]): RoutingConfidenceInfo {
  if (routed.length === 0) {
    return {
      level: 'low',
      scoreGap: 0,
      nearTopCount: 0,
      reason: 'no matching skills found'
    };
  }

  if (routed.length === 1) {
    const top = routed[0]!;
    return {
      level: top.score >= 10 ? 'high' : 'medium',
      scoreGap: top.score,
      nearTopCount: 1,
      reason: top.score >= 10
        ? 'single strong match'
        : 'single weak match'
    };
  }

  const topScore = routed[0]!.score;
  const secondScore = routed[1]!.score;
  const scoreGap = topScore - secondScore;

  // Count skills within 30% of top score (meaningful competitors)
  const threshold = Math.max(topScore * 0.7, topScore - 5);
  const nearTopCount = routed.filter((r) => r.score >= threshold).length;

  // High confidence: significant gap (>8 points) and top score is meaningful
  if (scoreGap >= 8 && topScore >= 14) {
    return {
      level: 'high',
      scoreGap,
      nearTopCount,
      reason: `clear winner: ${routed[0]!.skill.name} leads by ${scoreGap} points`
    };
  }

  // Low confidence: multiple skills with very similar scores
  if (scoreGap <= 3 && nearTopCount >= 2) {
    return {
      level: 'low',
      scoreGap,
      nearTopCount,
      reason: `ambiguous: ${nearTopCount} skills within reach of top score`
    };
  }

  // Medium confidence: top skill is distinguishable but not dominant
  return {
    level: 'medium',
    scoreGap,
    nearTopCount,
    reason: nearTopCount > 1
      ? `moderate clarity: ${nearTopCount} competitive candidates`
      : 'reasonable match with no strong competitors'
  };
}

/**
 * Assess confidence with particle-based robustness estimation.
 * Combines static score analysis with dynamic perturbation testing.
 * Inspired by arXiv:2603.01122's confidence-aware prediction framework.
 */
export function assessRoutingConfidenceWithRobustness(
  routed: RoutedSkill[],
  query: string,
  skills: SkillSpec[],
  options?: { particleCount?: number }
): RoutingConfidenceInfo {
  const base = assessRoutingConfidence(routed);

  // Compute robustness if we have meaningful results
  if (routed.length === 0 || routed[0]!.score < 2) {
    return { ...base, robustness: 0 };
  }

  const { robustness, topSkillName } = computeParticleRobustness(
    query,
    skills,
    Math.max(3, options?.particleCount ?? 5)
  );

  // Adjust confidence level based on robustness
  // Low robustness (< 0.5) downgrades confidence by one level
  // High robustness (> 0.8) upgrades confidence by one level
  let adjustedLevel = base.level;
  let reason = base.reason;

  if (robustness < 0.4 && base.level !== 'low') {
    // Low robustness: the match is fragile to query variations
    adjustedLevel = base.level === 'high' ? 'medium' : 'low';
    reason += `; low robustness (${(robustness * 100).toFixed(0)}%) suggests fragile match`;
  } else if (robustness >= 0.8 && base.level !== 'high') {
    // High robustness: consistent across perturbations
    if (base.level === 'medium' && robustness >= 0.9) {
      adjustedLevel = 'high';
      reason += `; high robustness (${(robustness * 100).toFixed(0)}%) confirms stable match`;
    }
  }

  // Check if robustness disagrees with top skill
  if (robustness > 0 && topSkillName && routed.length > 0 && routed[0]!.skill.name !== topSkillName) {
    // The most robust skill differs from the highest scoring skill
    reason += `; note: ${topSkillName} is more robust across query variations`;
  }

  return {
    ...base,
    level: adjustedLevel,
    reason,
    robustness
  };
}


/**
 * Route skills with FusionRAG-inspired context fusion.
 * When a skill matches, related skills get a context boost based on:
 * 1. Their relationship similarity
 * 2. Shared tokens with the query
 *
 * This addresses the "cross-chunk context" problem from the FusionRAG paper:
 * queries may match one skill's keywords but the user's intent is better
 * served by a related skill with different terminology.
 *
 * ## Holonomy-Aware Normalization
 * Inspired by "Categorical Belief Propagation" (arXiv:2601.04456), this function
 * applies holonomy corrections to prevent score inflation from mutual boosting
 * cycles. Skills in inflationary cycles receive a small penalty proportional
 * to the cycle's holonomy score.
 */
export function routeSkillsWithFusion(
  query: string,
  skills: SkillSpec[],
  cache: SkillRelationshipCache,
  topK: number
): RoutedSkill[] {
  const q = query.trim();
  if (!q) {
    return skills.slice(0, topK).map((skill) => ({ skill, score: 0, reason: '(empty query)' }));
  }

  const queryTokens = uniqueTokens(tokenize(q));
  const fullQ = queryTokens.join(' ').trim();
  const queryTokenSet = new Set(queryTokens);
  const skillByName = new Map(skills.map(s => [s.name, s]));

  // First pass: compute base lexical scores
  const baseScores = new Map<string, { score: number; hits: string[] }>();
  for (const skill of skills) {
    const result = lexicalScoreForSkill(skill, queryTokens, fullQ);
    baseScores.set(skill.name, result);
  }

  // Second pass: apply fusion boost from related skills
  const fusionBoosts = new Map<string, { boost: number; sources: string[] }>();

  for (const skill of skills) {
    const baseResult = baseScores.get(skill.name)!;
    if (baseResult.score < 2) continue; // Only boost from skills with meaningful matches

    const related = cache.relationships.get(skill.name) ?? [];
    for (const rel of related) {
      // Check if shared tokens match query tokens
      const matchingSharedTokens = rel.sharedTokens.filter(t => queryTokenSet.has(t));
      if (matchingSharedTokens.length === 0) continue;

      // Compute boost proportional to similarity and matching tokens
      const boost = Math.round(baseResult.score * rel.similarity * 0.3 * (matchingSharedTokens.length / Math.max(1, rel.sharedTokens.length)));

      if (boost > 0) {
        const existing = fusionBoosts.get(rel.skillName) ?? { boost: 0, sources: [] };
        existing.boost += boost;
        existing.sources.push(`${skill.name}(+${boost})`);
        fusionBoosts.set(rel.skillName, existing);
      }
    }
  }

  // Third pass: apply holonomy corrections for inflationary cycles
  const cycles = cache.cycles ?? [];
  const holonomyCorrections = new Map<string, { correction: number; cycleCount: number }>();
  for (const skill of skills) {
    const result = computeHolonomyCorrection(skill.name, cycles);
    if (result.correction > 0) {
      holonomyCorrections.set(skill.name, result);
    }
  }

  // Combine base scores with fusion boosts and holonomy corrections
  const results: RoutedSkill[] = skills.map((skill) => {
    const base = baseScores.get(skill.name)!;
    const fusion = fusionBoosts.get(skill.name);
    const holonomy = holonomyCorrections.get(skill.name);

    // Apply fusion boost
    let finalScore = base.score + (fusion?.boost ?? 0);

    // Apply holonomy correction (penalty for inflationary cycles)
    let holonomyNote = '';
    if (holonomy && finalScore > 0) {
      const correction = Math.min(holonomy.correction, finalScore * 0.3); // Cap at 30% of score
      finalScore = Math.max(0, finalScore - correction);
      holonomyNote = `; holonomy:-${correction.toFixed(1)} (${holonomy.cycleCount} cycle${holonomy.cycleCount > 1 ? 's' : ''})`;
    }

    let reason = base.hits.length ? base.hits.slice(0, 4).join(', ') : 'no-hit';

    if (fusion && fusion.boost > 0) {
      reason += `; fusion:+${fusion.boost} from ${fusion.sources.slice(0, 2).join(', ')}`;
    }

    if (holonomyNote) {
      reason += holonomyNote;
    }

    return { skill, score: Math.round(finalScore * 10) / 10, reason };
  });

  results.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return results.slice(0, topK);
}

