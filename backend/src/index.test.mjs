import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from './index.mjs';

function setup(overrides = {}) {
  const calls = { leads: [], emails: [], throttle: [] };
  const deps = {
    putLead: async (lead) => { calls.leads.push(lead); },
    countPriorLeads: async () => 0,
    bumpThrottle: async (ipHash, nowMs) => { calls.throttle.push([ipHash, nowMs]); return 1; },
    sendNotification: async (mail) => { calls.emails.push(mail); },
    now: () => Date.parse('2026-09-26T10:00:00.000Z'),
    config: { rateLimit: 5, ipSalt: 'test-salt' },
    ...overrides,
  };
  return { handler: createHandler(deps), calls };
}

function jsonEvent(payload, headers = {}) {
  return {
    body: JSON.stringify(payload),
    isBase64Encoded: false,
    headers: { 'content-type': 'application/json', ...headers },
    requestContext: { http: { sourceIp: '203.0.113.9' } },
  };
}

const good = { name: 'Ada', email: 'ada@example.com', formType: 'early-access' };

test('stores the lead and sends a notification', async () => {
  const { handler, calls } = setup();
  const res = await handler(jsonEvent(good));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(calls.leads.length, 1);
  assert.equal(calls.leads[0].fields.email, 'ada@example.com');
  assert.equal(calls.leads[0].submittedAt, '2026-09-26T10:00:00.000Z');
  assert.equal(calls.emails.length, 1);
});

test('never stores a raw IP, only a hash', async () => {
  const { handler, calls } = setup();
  await handler(jsonEvent(good));
  const { ipHash } = calls.leads[0];
  assert.match(ipHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(calls.leads[0]), /203\.0\.113\.9/);
});

test('honeypot returns a fake success and writes nothing', async () => {
  const { handler, calls } = setup();
  const res = await handler(jsonEvent({ ...good, _honey: 'gotcha' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(calls.leads.length, 0);
  assert.equal(calls.emails.length, 0);
});

test('rejects invalid submissions with 400 and stores nothing', async () => {
  const { handler, calls } = setup();
  const res = await handler(jsonEvent({ ...good, email: 'nope' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).ok, false);
  assert.equal(calls.leads.length, 0);
});

test('returns 429 once the rate limit is exceeded', async () => {
  const { handler, calls } = setup({ bumpThrottle: async () => 6 });
  const res = await handler(jsonEvent(good));
  assert.equal(res.statusCode, 429);
  assert.equal(calls.leads.length, 0);
});

test('rejects oversized bodies with 413', async () => {
  const { handler } = setup();
  const res = await handler(jsonEvent({ ...good, message: 'x'.repeat(70 * 1024) }));
  assert.equal(res.statusCode, 413);
});

test('a failed notification still succeeds, because the lead is already stored', async () => {
  const { handler, calls } = setup({
    sendNotification: async () => { throw new Error('SES is sulking'); },
  });
  const res = await handler(jsonEvent(good));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.leads.length, 1);
});

test('form-urlencoded submissions get a 303 to the validated _next', async () => {
  const { handler, calls } = setup();
  const res = await handler({
    body: 'name=Ada&email=ada%40example.com&formType=early-access&_next=https%3A%2F%2Fkineura.com%2F%3Fea%3D1',
    isBase64Encoded: false,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    requestContext: { http: { sourceIp: '203.0.113.9' } },
  });
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.Location, 'https://kineura.com/?ea=1');
  assert.equal(calls.leads.length, 1);
});

test('a hostile _next is replaced with the default redirect', async () => {
  const { handler } = setup();
  const res = await handler({
    body: 'name=Ada&email=ada%40example.com&formType=early-access&_next=https%3A%2F%2Fevil.example%2F',
    isBase64Encoded: false,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    requestContext: { http: { sourceIp: '203.0.113.9' } },
  });
  assert.equal(res.headers.Location, 'https://kineura.com/');
});

test('form-mode validation failure returns 400 HTML, not a fake success redirect', async () => {
  const { handler } = setup();
  const res = await handler({
    body: 'name=&email=nope&formType=early-access',
    isBase64Encoded: false,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    requestContext: { http: { sourceIp: '203.0.113.9' } },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.headers['Content-Type'], /text\/html/);
});

test('decodes base64-encoded bodies', async () => {
  const { handler, calls } = setup();
  const res = await handler({
    body: Buffer.from(JSON.stringify(good)).toString('base64'),
    isBase64Encoded: true,
    headers: { 'content-type': 'application/json' },
    requestContext: { http: { sourceIp: '203.0.113.9' } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.leads.length, 1);
});

test('records the referer and user agent', async () => {
  const { handler, calls } = setup();
  await handler(jsonEvent(good, {
    referer: 'https://kineura.com/for-teams-coaches.html',
    'user-agent': 'Mozilla/5.0',
  }));
  assert.equal(calls.leads[0].sourceUrl, 'https://kineura.com/for-teams-coaches.html');
  assert.equal(calls.leads[0].userAgent, 'Mozilla/5.0');
});
