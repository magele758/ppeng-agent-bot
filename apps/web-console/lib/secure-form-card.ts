/**
 * Chat card face for an in-chat Secure Form.
 * The card shows one masked field. It never carries a default secret,
 * and it is not the browser vault_fill card.
 */

export const SECURE_FORM_TOOL_NAME = 'secure_form';

export const SECURE_FORM_FIELDS = ['otp', 'password', 'cardNumber', 'cvv'] as const;

export type SecureFormCardField = (typeof SECURE_FORM_FIELDS)[number];

export type SecureFormCardFace = {
  id: string;
  field: SecureFormCardField;
  label: string;
  prompt: string;
  masked: true;
};

const FIELD_LABEL: Record<SecureFormCardField, string> = {
  otp: 'One-time code',
  password: 'Password',
  cardNumber: 'Card number',
  cvv: 'CVV'
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

/** Pending tool call: label and field only. The form id arrives with the tool result. */
export function secureFormCardFace(approval: {
  toolName: string;
  args?: Record<string, unknown>;
}): SecureFormCardFace | null {
  if (approval.toolName !== SECURE_FORM_TOOL_NAME) return null;
  return faceFrom(approval.args ?? {});
}

/** Tool-result card. This is the one the user fills; it carries the form id and no secret. */
export function secureFormResultCard(content: string): SecureFormCardFace | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const card = (parsed as { card?: unknown }).card;
  if (!card || typeof card !== 'object') return null;
  const row = card as Record<string, unknown>;
  if (row.kind !== 'secure_form' || row.status !== 'pending' || row.masked !== true) return null;
  const face = faceFrom(row);
  return face.id ? face : null;
}

/** Submit body. The value is sent once to the vault route and must not be copied into chat text. */
export function secureFormSubmitBody(face: SecureFormCardFace, value: string, action: 'submit' | 'cancel' = 'submit') {
  return {
    action,
    id: face.id,
    ...(action === 'submit' ? { value } : {})
  };
}
