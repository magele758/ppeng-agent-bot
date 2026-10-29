/** Lab User Vault card model: product entries (login / card / contact), uvref fill references. */

export type VaultKind = 'login' | 'card' | 'contact';

export const VAULT_KINDS: readonly VaultKind[] = ['login', 'card', 'contact'];

export interface VaultEntry {
  id: string;
  kind: VaultKind;
  label: string;
  hint?: string;
  fillRefs: Record<string, string>;
  login?: { username?: string; sites?: string[] };
  card?: { holderName?: string; expiry?: string; last4?: string };
  contact?: { fullName?: string; email?: string; phone?: string; address?: string };
}

export type VaultForm = Record<VaultFormField, string> & { kind: VaultKind };

export type VaultFormField =
  | 'label'
  | 'hint'
  | 'username'
  | 'sites'
  | 'password'
  | 'holderName'
  | 'expiry'
  | 'number'
  | 'cvv'
  | 'fullName'
  | 'email'
  | 'phone'
  | 'address';

/** Fields the form shows per kind (beyond label / hint). */
export const KIND_FIELDS: Record<VaultKind, readonly VaultFormField[]> = {
  login: ['username', 'sites', 'password'],
  card: ['holderName', 'expiry', 'number', 'cvv'],
  contact: ['fullName', 'email', 'phone', 'address']
};

/** Secret inputs are write-only: never read back from the API. */
export const SECRET_FORM_FIELDS: readonly VaultFormField[] = ['password', 'number', 'cvv'];

export function emptyForm(kind: VaultKind): VaultForm {
  return {
    kind,
    label: '',
    hint: '',
    username: '',
    sites: '',
    password: '',
    holderName: '',
    expiry: '',
    number: '',
    cvv: '',
    fullName: '',
    email: '',
    phone: '',
    address: ''
  };
}

/** POST body for /api/user-vault/entries: only the fields of this kind that were filled in. */
export function entryPayload(form: VaultForm): Record<string, unknown> {
  const body: Record<string, unknown> = { kind: form.kind, label: form.label.trim() };
  for (const field of ['hint', ...KIND_FIELDS[form.kind]] as VaultFormField[]) {
    const value = form[field].trim();
    if (value) body[field] = field === 'sites' ? value.split(/[\s,]+/).filter(Boolean) : value;
  }
  return body;
}

export function entryFillRefs(entry: VaultEntry): string[] {
  return Object.values(entry.fillRefs ?? {}).filter((ref) => ref.startsWith('uvref:'));
}

export function fillRefsText(entry: VaultEntry): string {
  return entryFillRefs(entry).join(', ');
}

/** One-line, non-secret summary shown under the label. */
export function entrySubtitle(entry: VaultEntry): string {
  const parts: Array<string | undefined> = [
    entry.login?.username,
    entry.card?.last4 ? `•••• ${entry.card.last4}` : undefined,
    entry.contact?.email ?? entry.contact?.fullName
  ];
  return parts.filter(Boolean).join(' · ');
}
