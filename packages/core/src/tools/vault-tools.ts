/**
 * `vault_*` assistant tools over UserVault (product login / card / contact entries).
 *
 * Not SecretVault: that store injects connector env values by name. These tools only
 * ever hand the model opaque `uvref:` fill references. Plaintext is resolved inside
 * `fillByReferences` and passed straight to the fill target (browser form field);
 * tool results carry refs and selectors only.
 */

import {
  assertModelFacingHasNoUserVaultSecrets,
  fillByReferences,
  type UserVault,
  type UserVaultEntryKind,
  type UserVaultEntrySummary
} from '../secrets/user-vault.js';
import type { RunContext, ToolContract, ToolExecutionResult } from '../types.js';

const KINDS: readonly UserVaultEntryKind[] = ['login', 'card', 'contact'];
export const VAULT_FILL_MAX_FIELDS = 20;

export interface VaultToolServices {
  getVault: () => UserVault;
  isEnabled: () => boolean;
  /** True when a form-fill target (browser) can accept values right now. */
  isFillTargetAvailable: () => boolean;
  /** Write one resolved value into a form field. Must not echo `value` in its result. */
  fillField: (context: RunContext, selector: string, value: string) => Promise<boolean>;
}

interface FillField {
  ref: string;
  selector: string;
}

const DISABLED_MESSAGE = 'User Vault tools are disabled (enable in Lab → Settings → Tools → User Vault)';

function fail(content: string): ToolExecutionResult {
  return { ok: false, content };
}

function matchesQuery(entry: UserVaultEntrySummary, query: string): boolean {
  const hay = [
    entry.label,
    entry.hint,
    entry.login?.username,
    ...(entry.login?.sites ?? []),
    entry.card?.holderName,
    entry.contact?.fullName,
    entry.contact?.email
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  return hay.includes(query);
}

function summarize(vault: UserVault, entries: UserVaultEntrySummary[]): ToolExecutionResult {
  const content = JSON.stringify({ count: entries.length, entries }, null, 2);
  assertModelFacingHasNoUserVaultSecrets(content, vault);
  return { ok: true, content };
}

function parseFields(raw: unknown): FillField[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'fields must be a non-empty array of { ref, selector }';
  if (raw.length > VAULT_FILL_MAX_FIELDS) return `at most ${VAULT_FILL_MAX_FIELDS} fields per call`;
  const out: FillField[] = [];
  for (const item of raw) {
    const ref = String((item as FillField | undefined)?.ref ?? '').trim();
    const selector = String((item as FillField | undefined)?.selector ?? '').trim();
    if (!ref || !selector) return 'each field needs both ref (uvref:…) and selector';
    out.push({ ref, selector });
  }
  return out;
}

export function createVaultTools(services: VaultToolServices): ToolContract<any>[] {
  const list: ToolContract<{ kind?: string; query?: string }> = {
    name: 'vault_list',
    description:
      'List the user’s Vault entries (logins, cards, contacts) for form filling. Returns labels and opaque uvref: fill references only — never passwords or card numbers. Pass a ref to vault_fill.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...KINDS] },
        query: { type: 'string', description: 'Case-insensitive match on label, site, username, or name' }
      }
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(_ctx, args) {
      if (!services.isEnabled()) return fail(DISABLED_MESSAGE);
      const vault = services.getVault();
      const kind = String(args.kind ?? '').trim();
      if (kind && !KINDS.includes(kind as UserVaultEntryKind)) return fail(`unknown kind: ${kind}`);
      const query = String(args.query ?? '').trim().toLowerCase();
      const entries = vault
        .list()
        .filter((e) => !kind || e.kind === kind)
        .filter((e) => !query || matchesQuery(e, query));
      return summarize(vault, entries);
    }
  };

  const get: ToolContract<{ id: string }> = {
    name: 'vault_get',
    description:
      'Get one Vault entry summary by id: non-secret details plus its uvref: fill references. Secret values are never returned.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(_ctx, args) {
      if (!services.isEnabled()) return fail(DISABLED_MESSAGE);
      const vault = services.getVault();
      const id = String(args.id ?? '').trim();
      const entry = id ? vault.getSummary(id) : undefined;
      if (!entry) return fail(`vault entry not found: ${id}`);
      const content = JSON.stringify(entry, null, 2);
      assertModelFacingHasNoUserVaultSecrets(content, vault);
      return { ok: true, content };
    }
  };

  const fill: ToolContract<{ fields: FillField[] }> = {
    name: 'vault_fill',
    description:
      'Fill form fields in the browser session from Vault references. Each field is { ref: "uvref:<id>:<field>", selector: CSS selector }. The value is resolved inside the runtime and typed into the page; you only ever see the refs. Requires browser tools and user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'uvref:<entryId>:<field> from vault_list / vault_get' },
              selector: { type: 'string', description: 'CSS selector of the target input' }
            },
            required: ['ref', 'selector']
          }
        }
      },
      required: ['fields']
    },
    approvalMode: 'always',
    sideEffectLevel: 'system',
    async execute(context, args) {
      if (!services.isEnabled()) return fail(DISABLED_MESSAGE);
      if (!services.isFillTargetAvailable()) {
        return fail('No form-fill target: enable browser tools (Lab → Settings → Tools) and navigate to the form first');
      }
      const fields = parseFields(args.fields);
      if (typeof fields === 'string') return fail(fields);
      const vault = services.getVault();
      const failed: FillField[] = [];
      const outcome = await fillByReferences(
        vault,
        fields.map((f) => f.ref),
        async (resolved) => {
          for (const field of fields) {
            const ok = await services.fillField(context, field.selector, resolved[field.ref]!);
            if (!ok) failed.push(field);
          }
        }
      );
      if (!outcome.ok) return fail(outcome.error);
      if (failed.length > 0) {
        return fail(
          `Could not fill ${failed.length} of ${fields.length} field(s): ${failed
            .map((f) => `${f.ref} → ${f.selector}`)
            .join(', ')}`
        );
      }
      const content = JSON.stringify(
        {
          ok: true,
          filled: outcome.modelReport.filled,
          fields: fields.map((f) => ({ ref: f.ref, selector: f.selector })),
          text: outcome.modelReport.text
        },
        null,
        2
      );
      assertModelFacingHasNoUserVaultSecrets(content, vault);
      return { ok: true, content };
    }
  };

  return [list, get, fill];
}
