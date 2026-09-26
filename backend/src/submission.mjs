// Pure submission handling: parsing, validation, redirect safety.
// No AWS imports here — every export is testable without network or mocks.

export const FORM_TYPES = ['early-access', 'coach-team', 'research-clinical'];

export const LIMITS = {
  name: 200,
  organization: 200,
  message: 5000,
  email: 320,
};

export const MAX_BODY_BYTES = 64 * 1024;

const ALLOWED_REDIRECT_ORIGIN = 'https://kineura.com';
export const DEFAULT_REDIRECT = 'https://kineura.com/';

// Deliberately permissive but structural: requires a dotted domain, so "a@b"
// is rejected where the old client-side `indexOf('@') < 1` accepted it.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export function normalizeEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

function toFields(obj) {
  const str = (v) => (v == null ? '' : String(v));
  return {
    name: str(obj.name).trim(),
    email: normalizeEmail(obj.email),
    organization: str(obj.organization).trim(),
    message: str(obj.message).trim(),
    formType: str(obj.formType).trim(),
    honeypot: str(obj._honey).trim(),
    next: str(obj._next).trim(),
  };
}

export function parseSubmission(contentType, rawBody) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();

  if (type === 'application/json') {
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { mode: 'json', fields: null, error: 'Malformed JSON body.' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { mode: 'json', fields: null, error: 'Malformed JSON body.' };
    }
    return { mode: 'json', fields: toFields(parsed), error: null };
  }

  if (type === 'application/x-www-form-urlencoded') {
    const obj = {};
    for (const [k, v] of new URLSearchParams(rawBody ?? '')) obj[k] = v;
    return { mode: 'form', fields: toFields(obj), error: null };
  }

  return { mode: 'json', fields: null, error: 'Unsupported content type.' };
}

export function validate(fields) {
  const fail = (error) => ({ ok: false, error });

  if (!fields.name) return fail('Please enter your name.');
  if (fields.name.length > LIMITS.name) return fail('Name is too long.');
  if (!fields.email || !EMAIL_RE.test(fields.email) || fields.email.length > LIMITS.email) {
    return fail('Please enter a valid email address.');
  }
  if (fields.organization.length > LIMITS.organization) return fail('Organization is too long.');
  if (fields.message.length > LIMITS.message) return fail('Message is too long.');
  if (!FORM_TYPES.includes(fields.formType)) return fail('Unknown form type.');

  return { ok: true, error: null };
}

export function isBot(fields) {
  return fields.honeypot.length > 0;
}

// `_next` is client-supplied. Anything not exactly on https://kineura.com is
// discarded, otherwise this endpoint is an open redirect wearing Kineura's domain.
export function resolveRedirect(next) {
  if (!next) return DEFAULT_REDIRECT;
  let url;
  try {
    url = new URL(next);
  } catch {
    return DEFAULT_REDIRECT;
  }
  return url.origin === ALLOWED_REDIRECT_ORIGIN ? url.toString() : DEFAULT_REDIRECT;
}
