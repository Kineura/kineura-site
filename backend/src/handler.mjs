import { createHash } from 'node:crypto';
import {
  parseSubmission, validate, isBot, resolveRedirect, MAX_BODY_BYTES, DEFAULT_REDIRECT,
} from './submission.mjs';
import { buildEmail } from './notification.mjs';

const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const USER_AGENT_CAP = 400;

function headerOf(event, name) {
  const headers = event.headers ?? {};
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return hit ? String(headers[hit]) : '';
}

function hashIp(ip, salt) {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function redirectResponse(location) {
  return { statusCode: 303, headers: { Location: location }, body: '' };
}

// The no-JS path must not redirect to the success URL on failure — that would
// tell the visitor their submission landed when it did not.
function htmlErrorResponse(statusCode, message) {
  const safe = String(message).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><meta charset="utf-8"><title>Submission not accepted</title>`
      + `<p>${safe}</p><p><a href="${DEFAULT_REDIRECT}">Return to kineura.com</a></p>`,
  };
}

export function createHandler(deps) {
  const { putLead, countPriorLeads, bumpThrottle, sendNotification, now, config } = deps;

  return async function handler(event) {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');

    const { mode, fields, error: parseError } = parseSubmission(
      headerOf(event, 'content-type'), rawBody,
    );

    const fail = (statusCode, message) => (mode === 'form'
      ? htmlErrorResponse(statusCode, message)
      : jsonResponse(statusCode, { ok: false, error: message }));

    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
      return fail(413, 'Submission too large.');
    }
    if (parseError) return fail(400, parseError);

    const redirectTo = resolveRedirect(fields.next);
    const succeed = () => (mode === 'form' ? redirectResponse(redirectTo) : jsonResponse(200, { ok: true }));

    // Honeypot: report success and write nothing. Telling the bot it was caught
    // only teaches it to stop filling the field.
    if (isBot(fields)) return succeed();

    const verdict = validate(fields);
    if (!verdict.ok) return fail(400, verdict.error);

    const nowMs = now();
    const ipHash = hashIp(event.requestContext?.http?.sourceIp ?? 'unknown', config.ipSalt);

    const attempts = await bumpThrottle(ipHash, nowMs);
    if (attempts > config.rateLimit) {
      return fail(429, 'Too many submissions from this connection. Please try again shortly.');
    }

    const submittedAt = new Date(nowMs).toISOString();
    const priorCount = await countPriorLeads(fields.email);

    await putLead({
      fields,
      submittedAt,
      ipHash,
      sourceUrl: headerOf(event, 'referer'),
      userAgent: headerOf(event, 'user-agent').slice(0, USER_AGENT_CAP),
    });

    // The lead is safely stored by this point. A notification failure is
    // recoverable from the table; failing the request here would not be.
    try {
      await sendNotification(buildEmail(fields, { submittedAt, priorCount }));
    } catch (err) {
      console.error('notification failed', err);
    }

    return succeed();
  };
}
