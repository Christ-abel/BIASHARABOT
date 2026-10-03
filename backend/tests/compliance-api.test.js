import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import { complianceRouter, businessAssessment } from '../compliance-api.js';
import Business from '../models/Business.js';
import Entry from '../models/Entry.js';
import Notice from '../models/ComplianceNotice.js';

test('business model defaults leave legacy compliance details unknown', () => {
  const business = new Business({ id: 'legacy', name: 'Legacy', phone: '0700000000', email: 'legacy@example.test', password: 'hash' });
  assert.equal(business.complianceProfile.legalStructure, 'unknown');
  assert.equal(business.complianceProfile.estimatedAnnualTurnover, null);
  assert.equal(business.complianceProfile.smsOptIn, false);
});

test('compliance APIs require password-derived scope, reject spoofing, and revoke sessions', async () => {
  const original = { businessFind: Business.findOne, entryFind: Entry.find, noticeFind: Notice.find, noticeInit: Notice.init };
  const business = new Business({ id: 'shop-a', name: 'A', phone: '0700000000', email: 'a@example.test', password: bcrypt.hashSync('secret', 4) });
  business.save = async () => business;
  let query;
  Business.findOne = async ({ id }) => id === business.id ? business : null;
  Entry.find = filter => { query = filter; return { select: () => ({ lean: async () => [] }) }; };
  Notice.find = () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) });
  Notice.init = async () => {};
  const app = express();
  app.use(express.json());
  app.use('/api/compliance', complianceRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/compliance`;
  const call = (path = '', options = {}) => fetch(url + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  try {
    assert.equal((await call('?businessId=shop-a')).status, 401);
    assert.equal((await call('/profile', { method: 'PUT', body: JSON.stringify({ county: 'Nairobi' }) })).status, 401);
    assert.equal((await call('/unlock', { method: 'POST', body: JSON.stringify({ businessId: 'shop-a', password: 'wrong' }) })).status, 401);
    const unlock = await call('/unlock', { method: 'POST', body: JSON.stringify({ businessId: 'shop-a', password: 'secret' }) });
    const { token } = await unlock.json();
    assert.ok(token);
    const headers = { Authorization: `Bearer ${token}` };
    const result = await call('?businessId=shop-b', { headers });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(query.business_id, 'shop-a');
    const bad = await call('/profile', { method: 'PUT', headers, body: JSON.stringify({ businessId: 'shop-b' }) });
    assert.equal(bad.status, 400);
    const saved = await call('/profile', { method: 'PUT', headers, body: JSON.stringify({ county: 'Nairobi', reportLanguage: 'sw' }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).items[0].title, 'PIN ya KRA');
    await call('/lock', { method: 'POST', headers });
    assert.equal((await call('', { headers })).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    Business.findOne = original.businessFind;
    Entry.find = original.entryFind;
    Notice.find = original.noticeFind;
    Notice.init = original.noticeInit;
  }
});

test('turnover excludes prior years, out-of-window and future transactions', async () => {
  const original = Entry.find;
  const now = new Date('2026-10-03T09:00:00Z');
  let filter;
  Entry.find = query => {
    filter = query;
    const data = [
      { timestamp: new Date('2025-12-10T09:00:00Z'), total: 200 },
      { timestamp: new Date('2026-05-10T09:00:00Z'), total: 300 },
    ];
    return { select: () => ({ lean: async () => data }) };
  };
  try {
    const assessment = await businessAssessment({ id: 'shop-a' }, now);
    assert.equal(assessment.ledger.calendarYearRevenue, 300);
    assert.equal(assessment.ledger.trailing12MonthRevenue, 500);
    assert.equal(filter.business_id, 'shop-a');
    assert.equal(filter.type, 'sale');
    assert.equal(filter.timestamp.$lte.toISOString(), now.toISOString());
    assert.equal(filter.timestamp.$gte.toISOString(), '2025-10-03T09:00:00.000Z');
  } finally { Entry.find = original; }
});
