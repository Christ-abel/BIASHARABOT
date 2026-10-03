import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeEmail,
  normalizeEmail,
  normalizePhone,
  rateLimit,
  validatePassword
} from '../auth.js';

test('normalizes Kenyan phone numbers for login lookup', () => {
  assert.equal(normalizePhone('0712345678'), '254712345678');
  assert.equal(normalizePhone('+254712345678'), '254712345678');
  assert.equal(normalizePhone('712345678'), '254712345678');
});

test('email lookup is case-insensitive', () => {
  assert.equal(normalizeEmail('  Owner@Shop.COM '), 'owner@shop.com');
  assert.equal(looksLikeEmail('owner@shop.com'), true);
  assert.equal(looksLikeEmail('owner@localhost'), true);
  assert.equal(looksLikeEmail('0712345678'), false);
});

test('rejects short passwords', () => {
  assert.throws(() => validatePassword('secret'), /at least 8/);
  assert.doesNotThrow(() => validatePassword('secret12'));
});

test('rate limit blocks a fifth try in the same window', () => {
  const key = `test:${Date.now()}`;
  for (let i = 0; i < 5; i += 1) assert.equal(rateLimit(key, { max: 5 }), true);
  assert.equal(rateLimit(key, { max: 5 }), false);
});
