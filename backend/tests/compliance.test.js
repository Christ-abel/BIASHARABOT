import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCompliance, noticeCandidates, validateProfile, kenyaDate } from '../compliance.js';
import { deliverNotice } from '../compliance-notices.js';

const now = new Date('2026-10-15T08:00:00Z');
const eligible = { legalStructure: 'sole_proprietor', resident: 'yes', totExcludedIncome: 'no', totElectionOut: 'no', estimatedAnnualTurnover: 2000000 };
const ledger = { calendarYear: 2026, calendarYearRevenue: 0, trailing12MonthRevenue: 0 };
const item = (profile, id, date = now, revenue = ledger) => assessCompliance(profile, revenue, date).items.find(i => i.id === id);

test('legacy businesses have safe unknown defaults, not inferred exemptions', () => {
  const result = assessCompliance({}, ledger, now);
  assert.equal(result.items.length, 6);
  assert.equal(result.profile.smsOptIn, false);
  assert.equal(item({}, 'tot').applicability, null);
  assert.ok(result.missingFields.includes('estimatedAnnualTurnover'));
});
test('TOT boundaries and exclusions', () => {
  for (const [turnover, applies] of [[1000000, false], [1000001, true], [25000000, true], [25000001, false]]) {
    assert.equal(item({ ...eligible, estimatedAnnualTurnover: turnover }, 'tot').applicability, applies);
  }
  for (const override of [{ resident: 'no' }, { totExcludedIncome: 'yes' }, { totElectionOut: 'yes' }]) {
    assert.equal(item({ ...eligible, ...override }, 'tot').applicability, false);
  }
  assert.equal(item({ ...eligible, resident: 'unknown' }, 'tot').applicability, null);
});
test('recorded sales can raise annual lower bound but never prove VAT-taxable sales', () => {
  const recorded = { ...ledger, calendarYearRevenue: 2000000, trailing12MonthRevenue: 5000000 };
  assert.equal(item({ ...eligible, estimatedAnnualTurnover: 500000 }, 'tot', now, recorded).applicability, true);
  assert.equal(item({}, 'vat', now, recorded).applicability, null);
  assert.equal(item({ taxableSupplies: 'yes', estimatedTaxableTurnover: 5000000 }, 'vat').status, 'action');
  assert.equal(item({ taxableSupplies: 'yes', estimatedTaxableTurnover: 4999999 }, 'vat').status, 'review');
  assert.equal(item({ vatRegistered: 'yes', taxableSupplies: 'no' }, 'vat').status, 'registered');
});
test('monthly deadlines roll over correctly in Kenya time', () => {
  assert.equal(item({ totRegistered: 'yes' }, 'tot').deadline, '2026-10-20');
  assert.equal(item({ totRegistered: 'yes' }, 'tot', new Date('2026-12-20T22:00:00Z')).deadline, '2027-01-20');
  assert.equal(kenyaDate(new Date('2026-12-31T22:00:00Z')), '2027-01-01');
});
test('annual rules respect 2027 changes and company financial year', () => {
  assert.equal(item(eligible, 'annual', new Date('2026-01-01T00:00:00Z')).deadline, '2026-06-30');
  assert.equal(item(eligible, 'annual').deadline, '2027-04-30');
  assert.equal(item({ legalStructure: 'partnership' }, 'annual').deadline, '2027-04-30');
  assert.equal(item({ legalStructure: 'company', accountingYearEndMonth: 12 }, 'annual').deadline, '2027-06-30');
  assert.equal(item({ legalStructure: 'company', accountingYearEndMonth: 6 }, 'annual').deadline, '2026-12-31');
  assert.equal(item({ legalStructure: 'company' }, 'annual').deadline, null);
});
test('county dates are never guessed', () => {
  assert.equal(item({ county: 'Mombasa' }, 'permit').deadline, null);
  assert.equal(item({ county: 'Nairobi', permitExpiry: '2026-12-31' }, 'permit').deadline, '2026-12-31');
});
test('profile validation rejects invalid figures, dates, fields and preferences', () => {
  for (const p of [{ estimatedAnnualTurnover: -1 }, { estimatedAnnualTurnover: Infinity }, { estimatedAnnualTurnover: '500' }, { permitExpiry: '2026-02-30' }, { smsOptIn: 'true' }, { accountingYearEndMonth: 13 }, { legalStructure: 'random' }, { password: 'oops' }]) {
    assert.throws(() => validateProfile(p));
  }
  assert.deepEqual(validateProfile({ estimatedAnnualTurnover: 0, reportLanguage: 'sw' }), { estimatedAnnualTurnover: 0, reportLanguage: 'sw' });
});
test('threshold alerts use correct boundaries and retain stable keys', () => {
  const candidates = noticeCandidates(assessCompliance({}, { ...ledger, calendarYearRevenue: 1000000, trailing12MonthRevenue: 4999999 }, now));
  assert.equal(candidates.length, 0);
  const alerts = noticeCandidates(assessCompliance({}, { ...ledger, calendarYearRevenue: 1000001, trailing12MonthRevenue: 5000000 }, now));
  assert.deepEqual(alerts.map(n => n.obligation), ['tot', 'vat']);
  assert.equal(alerts[1].key, 'vat:threshold:once:5000000');
  assert.equal(noticeCandidates(assessCompliance({ totExcludedIncome: 'yes', taxableSupplies: 'no' }, { ...ledger, calendarYearRevenue: 6000000, trailing12MonthRevenue: 6000000 }, now)).length, 0);
});
test('reminders are limited to deadline window and localized without AI', () => {
  const profile = { totRegistered: 'yes', reportLanguage: 'sw' };
  const within = noticeCandidates(assessCompliance(profile, ledger, now));
  assert.equal(within.length, 1);
  assert.match(within[0].message, /2026-10-20/);
  assert.match(within[0].message, /inakaribia/);
  assert.equal(noticeCandidates(assessCompliance(profile, ledger, new Date('2026-10-01T08:00:00Z'))).length, 0);
});

function memoryStore() {
  const records = new Map();
  return {
    records,
    async updateOne(query, update) {
      const key = query._id || `${query.business_id}/${query.key}`;
      if (!records.has(key) && update.$setOnInsert) records.set(key, { ...update.$setOnInsert, _id: key });
      if (records.has(key) && update.$set) Object.assign(records.get(key), update.$set);
    },
    async findOneAndUpdate(query, update) {
      const record = records.get(`${query.business_id}/${query.key}`);
      if (!record || record.status !== query.status) return null;
      Object.assign(record, update.$set);
      return { ...record };
    },
  };
}
test('concurrent workers and repeated runs send one SMS per obligation window', async () => {
  const store = memoryStore();
  let count = 0;
  const args = { store, business: { id: 'shop', phone: '0700000000', complianceProfile: { smsOptIn: true } }, candidate: { key: 'tot:deadline:2026-10-20', message: 'test' }, send: async () => { count++; return { success: true }; } };
  await Promise.all(Array.from({ length: 10 }, () => deliverNotice(args)));
  assert.equal(count, 1);
  assert.equal([...store.records.values()][0].status, 'sent');
  await deliverNotice({ ...args, candidate: { ...args.candidate, key: 'tot:deadline:2026-11-20' } });
  assert.equal(count, 2);
});
test('opt-out prevents delivery; ambiguous failures and mock sends never repeat', async () => {
  const store = memoryStore();
  let count = 0;
  const args = { store, business: { id: 'shop', complianceProfile: { smsOptIn: false } }, candidate: { key: 'notice', message: 'test' }, send: async () => { count++; throw new Error('timeout'); } };
  await deliverNotice(args);
  assert.equal(count, 0);
  args.business.complianceProfile.smsOptIn = true;
  await deliverNotice(args); await deliverNotice(args);
  assert.equal(count, 1);
  assert.equal([...store.records.values()][0].status, 'unknown');
  const mock = await deliverNotice({ ...args, candidate: { key: 'mock', message: 'test' }, send: async () => ({ success: true, mock: true }) });
  assert.equal(mock.status, 'mock');
});
