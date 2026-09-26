import { createHash } from 'node:crypto';
import { DynamoDBClient, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
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

const ddb = new DynamoDBClient({});
const ses = new SESv2Client({});

const LEADS_TABLE = process.env.LEADS_TABLE;
const THROTTLE_TABLE = process.env.THROTTLE_TABLE;

export const handler = createHandler({
  now: () => Date.now(),
  config: {
    rateLimit: Number(process.env.RATE_LIMIT ?? 5),
    ipSalt: process.env.IP_SALT ?? '',
  },

  putLead: async ({ fields, submittedAt, ipHash, sourceUrl, userAgent }) => {
    const item = {
      email: { S: fields.email },
      submittedAt: { S: submittedAt },
      name: { S: fields.name },
      formType: { S: fields.formType },
      status: { S: 'new' },
      ipHash: { S: ipHash },
    };
    if (fields.organization) item.organization = { S: fields.organization };
    if (fields.message) item.message = { S: fields.message };
    if (sourceUrl) item.sourceUrl = { S: sourceUrl };
    if (userAgent) item.userAgent = { S: userAgent };

    await ddb.send(new PutItemCommand({ TableName: LEADS_TABLE, Item: item }));
  },

  countPriorLeads: async (email) => {
    const out = await ddb.send(new QueryCommand({
      TableName: LEADS_TABLE,
      KeyConditionExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': { S: email } },
      Select: 'COUNT',
    }));
    return out.Count ?? 0;
  },

  // The window index is part of the key, so each 10-minute window is its own
  // row. TTL lag (which can reach 48h) then cannot keep a counter tripped.
  bumpThrottle: async (ipHash, nowMs) => {
    const window = Math.floor(nowMs / THROTTLE_WINDOW_MS);
    const expiresAt = Math.floor((window + 2) * THROTTLE_WINDOW_MS / 1000);
    const out = await ddb.send(new UpdateItemCommand({
      TableName: THROTTLE_TABLE,
      Key: { throttleKey: { S: `${ipHash}#${window}` } },
      UpdateExpression: 'ADD #c :one SET #e = if_not_exists(#e, :exp)',
      ExpressionAttributeNames: { '#c': 'count', '#e': 'expiresAt' },
      ExpressionAttributeValues: { ':one': { N: '1' }, ':exp': { N: String(expiresAt) } },
      ReturnValues: 'UPDATED_NEW',
    }));
    return Number(out.Attributes?.count?.N ?? 1);
  },

  sendNotification: async ({ subject, body, replyTo }) => {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: process.env.SENDER_ADDRESS,
      Destination: { ToAddresses: [process.env.NOTIFY_EMAIL] },
      ReplyToAddresses: [replyTo],
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: body, Charset: 'UTF-8' } },
        },
      },
    }));
  },
});
