/**
 * Chat card face for an in-chat Secure Form.
 * Supports both single-field (backward compat) and multi-field rendering.
 * Never carries a default secret; not the browser vault_fill card.
 */

export const SECURE_FORM_TOOL_NAME = 'secure_form';

export const SECURE_FORM_FIELDS = ['otp', 'password', 'cardNumber', 'cvv', 'username'] as const;

export type SecureFormCardField = (typeof SECURE_FORM_FIELDS)[number];

/** Single-field card face (backward compat). */
export type SecureFormCardFace = {
  id: string;
  field: SecureFormCardField;
  label: string;
  prompt: string;
  masked: true;
};

/** Multi-field card face. */
export type SecureFormCardMultiFace = {
  id: string;
  fields: Array<{ field: SecureFormCardField; label: string }>;
  masked: true;
};

export type SecureFormCardAny = SecureFormCardFace | SecureFormCardMultiFace;

const FIELD_LABEL: Record<SecureFormCardField, string> = {
  otp: 'One-time code',
  password: 'Password',
  cardNumber: 'Card number',
  cvv: 'CVV',
  username: 'Username'
};

function isField(value: string): value is SecureFormCardField {
  return (SECURE_FORM_FIELDS as readonly string[]).includes(value);
}

function faceFrom(source: Record<string, unknown>): SecureFormCardFace {
  const rawField = typeof source.field === 'string' ? source.field.trim() : 'otp';
  const field = isField(rawField) ? rawField : 'otp';
  const label = typeof source.label === 'string' && source.label.trim() ? source.label.trim() : FIELD_LABEL[field];
  const prompt =
    typeof source.prompt === 'string' && source.prompt.trim()
      ? source.prompt.trim()
      : `Enter ${label.toLowerCase()}. It stays out of the chat.`;
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  return { id, field, label, prompt, masked: true };
}

function multiFaceFrom(source: Record<string, unknown>): SecureFormCardMultiFace | null {
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  if (!id) return null;
  const fieldsRaw = source.fields;
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) return null;
  const fields: Array<{ field: SecureFormCardField; label: string }> = [];
  for (const spec of fieldsRaw) {
    if (!spec || typeof spec !== 'object') continue;
    const fieldRaw = typeof spec.field === 'string' ? spec.field.trim() : '';
    if (!isField(fieldRaw)) continue;
    const label = typeof spec.label === 'string' && spec.label.trim() ? spec.label.trim() : FIELD_LABEL[fieldRaw];
    fields.push({ field: fieldRaw, label });
  }
  return fields.length > 0 ? { id, fields, masked: true } : null;
}

/** Pending tool call: label and field only. The form id arrives with the tool result. */
export function secureFormCardFace(approval: {
  toolName: string;
  args?: Record<string, unknown>;
}): SecureFormCardFace | null {
  if (approval.toolName !== SECURE_FORM_TOOL_NAME) return null;
  return faceFrom(approval.args ?? {});
}

/** Tool-result card. Supports both single and multi-field. */
export function secureFormResultCard(content: string): SecureFormCardAny | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!('card' in parsed)) return null;
  const card = parsed.card;
  if (!card || typeof card !== 'object') return null;
  if (!('kind' in card) || !('status' in card) || !('masked' in card)) return null;
  if (card.kind !== 'secure_form' || card.status !== 'pending' || card.masked !== true) return null;
  
  const row = card as Record<string, unknown>;
  // Try multi-field first
  const multiFace = multiFaceFrom(row);
  if (multiFace) return multiFace;

  // Fall back to single-field
  const face = faceFrom(row);
  return face.id ? face : null;
}

function isMultiFace(face: SecureFormCardAny): face is SecureFormCardMultiFace {
  return 'fields' in face;
}

/** Submit body for single-field (backward compat). */
export function secureFormSubmitBody(
  face: SecureFormCardFace,
  value: string,
  action: 'submit' | 'cancel' = 'submit'
) {
  return {
    action,
    id: face.id,
    ...(action === 'submit' ? { value } : {})
  };
}

/** Submit body for multi-field. */
export function secureFormSubmitBodyMulti(
  face: SecureFormCardMultiFace,
  values: Record<string, string>,
  action: 'submit' | 'cancel' = 'submit'
) {
  return {
    action,
    id: face.id,
    ...(action === 'submit' ? { values } : {})
  };
}

/** Universal submit body handler. */
export function secureFormSubmitBodyAny(
  face: SecureFormCardAny,
  input: string | Record<string, string>,
  action: 'submit' | 'cancel' = 'submit'
) {
  if (isMultiFace(face)) {
    return secureFormSubmitBodyMulti(face, typeof input === 'string' ? {} : input, action);
  }
  return secureFormSubmitBody(face, typeof input === 'string' ? input : '', action);
}
