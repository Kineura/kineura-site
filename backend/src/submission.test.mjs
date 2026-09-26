import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSubmission, validate, isBot, resolveRedirect, normalizeEmail, DEFAULT_REDIRECT,
} from './submission.mjs';

test('normalizeEmail lowercases and trims', () => {
  assert.equal(normalizeEmail('  Peter@Kineura.COM '), 'peter@kineura.com');
  assert.equal(normalizeEmail(undefined), '');
});

test('parseSubmission reads JSON bodies', () => {
  const body = JSON.stringify({ name: 'Ada', email: 'A@B.com', formType: 'early-access' });
  const out = parseSubmission('application/json', body);
  assert.equal(out.mode, 'json');
  assert.equal(out.error, null);
  assert.equal(out.fields.name, 'Ada');
  assert.equal(out.fields.email, 'a@b.com');
  assert.equal(out.fields.organization, '');
});

test('parseSubmission reads form-urlencoded bodies', () => {
  const out = parseSubmission('application/x-www-form-urlencoded; charset=UTF-8',
    'name=Ada&email=a%40b.com&formType=coach-team&_honey=');
  assert.equal(out.mode, 'form');
  assert.equal(out.fields.formType, 'coach-team');
  assert.equal(out.fields.honeypot, '');
});

test('parseSubmission rejects malformed JSON and unknown content types', () => {
  assert.equal(parseSubmission('application/json', '{nope').fields, null);
  assert.equal(parseSubmission('application/json', '["array"]').fields, null);
  assert.equal(parseSubmission('text/plain', 'hi').error, 'Unsupported content type.');
});

test('validate accepts a good submission', () => {
  const { fields } = parseSubmission('application/json', JSON.stringify({
    name: 'Ada', email: 'ada@example.com', formType: 'early-access',
  }));
  assert.deepEqual(validate(fields), { ok: true, error: null });
});

test('validate rejects missing name, bad email, unknown formType', () => {
  const build = (o) => parseSubmission('application/json', JSON.stringify(o)).fields;
  assert.equal(validate(build({ email: 'a@b.com', formType: 'early-access' })).ok, false);
  assert.equal(validate(build({ name: 'A', email: 'nope', formType: 'early-access' })).ok, false);
  assert.equal(validate(build({ name: 'A', email: 'a@b', formType: 'early-access' })).ok, false);
  assert.equal(validate(build({ name: 'A', email: 'a@b.com', formType: 'bogus' })).ok, false);
});

test('validate enforces length caps', () => {
  const build = (o) => parseSubmission('application/json', JSON.stringify(o)).fields;
  const base = { email: 'a@b.com', formType: 'early-access' };
  assert.equal(validate(build({ ...base, name: 'x'.repeat(201) })).ok, false);
  assert.equal(validate(build({ ...base, name: 'A', organization: 'x'.repeat(201) })).ok, false);
  assert.equal(validate(build({ ...base, name: 'A', message: 'x'.repeat(5001) })).ok, false);
  assert.equal(validate(build({ ...base, name: 'A', message: 'x'.repeat(5000) })).ok, true);
});

test('isBot detects a filled honeypot', () => {
  const build = (h) => parseSubmission('application/json', JSON.stringify({ _honey: h })).fields;
  assert.equal(isBot(build('')), false);
  assert.equal(isBot(build('spam')), true);
});

test('resolveRedirect only trusts kineura.com origins', () => {
  assert.equal(resolveRedirect('https://kineura.com/?ea=1'), 'https://kineura.com/?ea=1');
  assert.equal(resolveRedirect('https://evil.example/steal'), DEFAULT_REDIRECT);
  assert.equal(resolveRedirect('http://kineura.com/?ea=1'), DEFAULT_REDIRECT);
  assert.equal(resolveRedirect('https://kineura.com.evil.example/'), DEFAULT_REDIRECT);
  assert.equal(resolveRedirect('//evil.example'), DEFAULT_REDIRECT);
  assert.equal(resolveRedirect(''), DEFAULT_REDIRECT);
});
