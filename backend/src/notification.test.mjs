import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEmail, subjectFor } from './notification.mjs';

const fields = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  organization: 'Analytical Engines',
  message: 'Curious about fatigue drift.',
  formType: 'coach-team',
  honeypot: '',
  next: '',
};

test('subjectFor matches the historical FormSubmit subjects', () => {
  assert.equal(subjectFor('early-access'), 'Kineura early access request');
  assert.equal(subjectFor('coach-team'), 'Kineura team/coach inquiry');
  assert.equal(subjectFor('research-clinical'), 'Kineura research/clinical inquiry');
  assert.equal(subjectFor('nonsense'), 'Kineura inquiry');
});

test('buildEmail includes every supplied field and replies to the submitter', () => {
  const mail = buildEmail(fields, { submittedAt: '2026-09-26T10:00:00.000Z', priorCount: 0 });
  assert.equal(mail.subject, 'Kineura team/coach inquiry');
  assert.equal(mail.replyTo, 'ada@example.com');
  assert.match(mail.body, /Ada Lovelace/);
  assert.match(mail.body, /ada@example\.com/);
  assert.match(mail.body, /Analytical Engines/);
  assert.match(mail.body, /Curious about fatigue drift\./);
  assert.match(mail.body, /2026-09-26T10:00:00\.000Z/);
  assert.doesNotMatch(mail.body, /submitted 0 time/);
});

test('buildEmail omits empty optional fields', () => {
  const bare = { ...fields, organization: '', message: '' };
  const mail = buildEmail(bare, { submittedAt: '2026-09-26T10:00:00.000Z' });
  assert.doesNotMatch(mail.body, /Organization:/);
  assert.doesNotMatch(mail.body, /Message:/);
});

test('buildEmail flags repeat submitters', () => {
  const mail = buildEmail(fields, { submittedAt: '2026-09-26T10:00:00.000Z', priorCount: 2 });
  assert.match(mail.body, /submitted 2 time\(s\) before/);
});
