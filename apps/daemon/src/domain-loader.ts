/**
 * Resolve domain bundles. Selection lives in core `resolveDomainSelection(env)`:
 * an explicit `RAW_AGENT_DOMAINS` CSV wins; when it is unset, `SRE_*` / `STOCK_*`
 * connection settings auto-mount the matching read-only pack.
 *
 * Known domain ids come from repo-root `domains.manifest.json` (single source of
 * truth with build / Docker / desktop assembly). Bundle modules are still
 * static-imported so production stays free of dynamic-import surprises.
 *
 * Unknown ids are logged once and skipped (rather than crashing the daemon)
 * so a typo in an ops-set env var doesn't take down the whole runtime.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeDomainBundles,
  resolveDomainSelection,
  type ConfigSource,
  type DomainBundle,
  type MergedDomainBundles,
} from '@ppeng/agent-core';
import { sreBundle } from '@ppeng/agent-sre';
import { stockBundle } from '@ppeng/agent-stock';
import { homeiotBundle } from '@ppeng/agent-homeiot';
import { erpBundle } from '@ppeng/agent-erp';

type DomainManifestEntry = {
  id: string;
  npmName: string;
  path: string;
  bundleExport: string;
};

type DomainsManifest = {
  domains: DomainManifestEntry[];
};

function loadManifest(): DomainsManifest {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ and dist/ are both apps/daemon/{src|dist} → three levels up is repo root
  const manifestPath = join(here, '../../../domains.manifest.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as DomainsManifest;
}

const MANIFEST = loadManifest();

/** Domain ids from domains.manifest.json (manifest order). */
export const KNOWN_DOMAINS: readonly string[] = MANIFEST.domains.map((d) => d.id);

const REGISTRY: Record<string, DomainBundle> = {
  sre: sreBundle,
  stock: stockBundle,
  homeiot: homeiotBundle,
  erp: erpBundle,
};

function assertRegistryMatchesManifest(): void {
  const registryIds = new Set(Object.keys(REGISTRY));
  const missing = KNOWN_DOMAINS.filter((id) => !registryIds.has(id));
  const extra = [...registryIds].filter((id) => !KNOWN_DOMAINS.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `domain-loader REGISTRY drifted from domains.manifest.json: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`
    );
  }
}

assertRegistryMatchesManifest();

export interface LoadedDomains {
  ids: string[];
  source: ConfigSource;
  /** 自动挂载时每个领域命中的连接信息 env 名。 */
  detected: Record<string, string[]>;
  unknown: string[];
  merged: MergedDomainBundles;
}

export function loadDomainBundles(env: NodeJS.ProcessEnv): LoadedDomains {
  const selection = resolveDomainSelection(env);
  const wanted = selection.ids;

  const bundles: DomainBundle[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const id of wanted) {
    if (seen.has(id)) continue;
    seen.add(id);
    const bundle = REGISTRY[id];
    if (!bundle) {
      unknown.push(id);
      continue;
    }
    bundles.push(bundle);
  }

  return {
    ids: bundles.map((b) => b.id),
    source: selection.source,
    detected: selection.detected,
    unknown,
    merged: mergeDomainBundles(bundles),
  };
}

/**
 * Connector rows for callers using explicit environment-based bootstrap.
 * The daemon registers installedDomainBundles and controls availability through Lab.
 */
export function describeDomainConnectors(loaded: LoadedDomains): Array<{
  id: string;
  title: string;
  instructions: string;
}> {
  const out: Array<{ id: string; title: string; instructions: string }> = [];
  for (const id of loaded.ids) {
    const bundle = REGISTRY[id];
    if (!bundle) continue;
    out.push({ id: bundle.id, title: bundle.label, instructions: '' });
  }
  return out;
}

/** Available bundle ids — useful for UI hints / `--help` output. */
export function availableDomainIds(): string[] {
  return [...KNOWN_DOMAINS];
}

export function installedDomainBundles(): DomainBundle[] { return KNOWN_DOMAINS.map(id=>REGISTRY[id]!); }
