import type { SelfHealPolicy, SelfHealTestPreset } from '../types.js';

const PRESETS: SelfHealTestPreset[] = ['unit', 'regression', 'e2e', 'remote', 'ci', 'build'];

function isPreset(v: unknown): v is SelfHealTestPreset {
  return typeof v === 'string' && (PRESETS as string[]).includes(v);
}

/** npm script name for `pnpm run <x>` (allowed characters). */
export function isValidCustomNpmScriptName(name: string): boolean {
  return /^[a-zA-Z0-9:_-]+$/.test(name);
}

export function npmScriptForSelfHealPolicy(policy: SelfHealPolicy): string {
  if (policy.testPreset === 'custom') {
    const s = policy.customNpmScript?.trim() ?? '';
    if (!isValidCustomNpmScriptName(s)) {
      throw new Error(
        'Self-heal policy: customNpmScript must be a single npm script name (e.g. test:unit), letters/digits/:/_/- only'
      );
    }
    return s;
  }
  switch (policy.testPreset) {
    case 'unit':
      return 'test:unit';
    case 'regression':
      return 'test:regression';
    case 'e2e':
      return 'test:e2e';
    case 'remote':
      return 'test:remote';
    case 'ci':
      return 'ci';
    case 'build':
      return 'build';
    default:
      return 'test:unit';
  }
}

export function normalizeSelfHealPolicy(input: Partial<SelfHealPolicy> | undefined): SelfHealPolicy {
  const testPresetRaw = input?.testPreset;
  const testPreset: SelfHealPolicy['testPreset'] =
    testPresetRaw === 'custom'
      ? 'custom'
      : isPreset(testPresetRaw)
        ? testPresetRaw
        : ((process.env.RAW_AGENT_SELF_HEAL_TEST_PRESET as SelfHealTestPreset | undefined) &&
          isPreset(process.env.RAW_AGENT_SELF_HEAL_TEST_PRESET)
            ? process.env.RAW_AGENT_SELF_HEAL_TEST_PRESET
            : 'unit');

  let maxFix = Number(input?.maxFixIterations ?? process.env.RAW_AGENT_SELF_HEAL_MAX_ITERATIONS);
  if (!Number.isFinite(maxFix) || maxFix < 1) maxFix = 5;
  if (maxFix > 50) maxFix = 50;

  const autoMerge =
    typeof input?.autoMerge === 'boolean'
      ? input.autoMerge
      : String(process.env.RAW_AGENT_SELF_HEAL_AUTO_MERGE ?? '').trim().toLowerCase() === '1' ||
        String(process.env.RAW_AGENT_SELF_HEAL_AUTO_MERGE ?? '').trim().toLowerCase() === 'true';
  const autoRestartDaemon =
    typeof input?.autoRestartDaemon === 'boolean'
      ? input.autoRestartDaemon
      : String(process.env.RAW_AGENT_SELF_HEAL_AUTO_RESTART ?? '').trim().toLowerCase() === '1' ||
        String(process.env.RAW_AGENT_SELF_HEAL_AUTO_RESTART ?? '').trim().toLowerCase() === 'true';

  const customNpmScript =
    typeof input?.customNpmScript === 'string'
      ? input.customNpmScript
      : process.env.RAW_AGENT_SELF_HEAL_CUSTOM_SCRIPT?.trim();

  const agentId =
    typeof input?.agentId === 'string' && input.agentId.trim()
      ? input.agentId.trim()
      : process.env.RAW_AGENT_SELF_HEAL_AGENT_ID?.trim() || 'self-healer';

  const targetBranch =
    typeof input?.targetBranch === 'string' && input.targetBranch.trim()
      ? input.targetBranch.trim()
      : process.env.RAW_AGENT_SELF_HEAL_TARGET_BRANCH?.trim() || undefined;

  const allowExternalAiTools =
    input?.allowExternalAiTools === true ||
    String(process.env.RAW_AGENT_SELF_HEAL_ALLOW_EXTERNAL_AI ?? '').trim().toLowerCase() === '1' ||
    String(process.env.RAW_AGENT_SELF_HEAL_ALLOW_EXTERNAL_AI ?? '').trim().toLowerCase() === 'true';

  return {
    testPreset,
    customNpmScript: testPreset === 'custom' ? customNpmScript : undefined,
    maxFixIterations: maxFix,
    autoMerge,
    autoRestartDaemon,
    targetBranch,
    agentId,
    allowExternalAiTools
  };
}
