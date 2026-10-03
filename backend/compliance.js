import { rules } from './compliance-config.js';

export const profileDefaults = {
  legalStructure: 'unknown', activity: 'unknown', county: '', hasKraPin: 'unknown',
  estimatedAnnualTurnover: null, resident: 'unknown', totExcludedIncome: 'unknown',
  totElectionOut: 'unknown', taxableSupplies: 'unknown', estimatedTaxableTurnover: null,
  vatRegistered: 'unknown', totRegistered: 'unknown', etimsRegistered: 'unknown',
  permitExpiry: '', accountingYearEndMonth: null, reportLanguage: 'en', smsOptIn: false,
};
const enums = {
  legalStructure: ['unknown', 'sole_proprietor', 'partnership', 'company'],
  activity: ['unknown', 'retail', 'online_shop', 'food_vendor', 'freelancer', 'mobile_money', 'other'],
  reportLanguage: ['en', 'sw'],
};
export function validateProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid compliance profile');
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(key in profileDefaults)) throw new Error(`Unknown profile field: ${key}`);
    if (enums[key]) {
      if (!enums[key].includes(value)) throw new Error(`Invalid ${key}`);
    } else if (['estimatedAnnualTurnover', 'estimatedTaxableTurnover'].includes(key)) {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error(`Invalid ${key}`);
    } else if (key === 'accountingYearEndMonth') {
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > 12)) throw new Error('Invalid year-end month');
    } else if (key === 'smsOptIn') {
      if (typeof value !== 'boolean') throw new Error('Invalid SMS preference');
    } else if (key === 'county') {
      if (typeof value !== 'string' || value.length > 60 || /[\r\n]/.test(value)) throw new Error('Invalid county');
    } else if (key === 'permitExpiry') {
      if (typeof value !== 'string' || (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value))) throw new Error('Invalid permit expiry');
    } else if (!['unknown', 'yes', 'no'].includes(value)) throw new Error(`Invalid ${key}`);
    result[key] = value;
  }
  return result;
}
export function kenyaDate(now = new Date()) {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const dateString = (year, month, day) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
function monthlyDeadline(today, day) {
  const [y, m, d] = today.split('-').map(Number);
  return dateString(y, m + (d > day ? 1 : 0), day);
}
function annualDeadline(p, today) {
  const year = Number(today.slice(0, 4));
  for (let y = year - 1; y <= year + 1; y++) {
    let due;
    if (p.legalStructure === 'company') {
      if (!p.accountingYearEndMonth) return null;
      // Last day of the sixth month following accounting year-end.
      due = dateString(y, p.accountingYearEndMonth + rules.annual.companyMonthsAfterYearEnd + 1, 0);
    } else if (p.legalStructure !== 'unknown') {
      let month = rules.annual.individualMonth;
      for (const change of rules.annual.individualChanges) if (`${y}-01-01` >= change.effective) month = change.month;
      due = dateString(y, month + 1, 0);
    }
    if (due && due >= today) return due;
  }
  return null;
}
export function assessCompliance(profile = {}, ledger = {}, now = new Date()) {
  const p = { ...profileDefaults, ...profile };
  const today = kenyaDate(now);
  const text = rules.text[p.reportLanguage] || rules.text.en;
  const figures = { totMin: rules.tot.minimumExclusive.toLocaleString('en-KE'), totMax: rules.tot.maximumInclusive.toLocaleString('en-KE'), vatMin: rules.vat.minimumInclusive.toLocaleString('en-KE'), totDay: rules.tot.dueDay, vatDay: rules.vat.dueDay };
  // Recorded revenue is a lower bound, never proof of complete annual turnover.
  const annual = p.estimatedAnnualTurnover === null ? null : Math.max(p.estimatedAnnualTurnover, ledger.calendarYearRevenue || 0);
  const totExcluded = p.resident === 'no' || p.totExcludedIncome === 'yes' || p.totElectionOut === 'yes';
  const totKnown = annual !== null && [p.resident, p.totExcludedIncome, p.totElectionOut].every(v => v !== 'unknown');
  const totEligible = !totExcluded && totKnown && annual > rules.tot.minimumExclusive && annual <= rules.tot.maximumInclusive;
  const vatEligible = p.taxableSupplies === 'yes' && p.estimatedTaxableTurnover !== null && p.estimatedTaxableTurnover >= rules.vat.minimumInclusive;
  const items = [];
  const add = (id, applicability, status, deadline = null, source = rules.sources[id]) => items.push({
    id, title: text[id][0], explanation: text[id][1].replace(/\{(\w+)\}/g, (_, key) => figures[key] ?? ''), applicability, status,
    statusLabel: text.statuses[status], deadline, source,
  });
  add('pin', true, p.hasKraPin === 'yes' ? 'registered' : p.hasKraPin === 'no' ? 'action' : 'unknown');
  add('tot', p.totRegistered === 'yes' || totEligible ? true : totExcluded || (totKnown && !totEligible) ? false : null,
    p.totRegistered === 'yes' ? 'registered' : totEligible ? 'action' : totExcluded || (totKnown && !totEligible) ? 'not_applicable' : 'unknown',
    p.totRegistered === 'yes' ? monthlyDeadline(today, rules.tot.dueDay) : null);
  add('vat', p.vatRegistered === 'yes' || vatEligible ? true : p.taxableSupplies === 'no' ? false : null,
    p.vatRegistered === 'yes' ? 'registered' : vatEligible ? 'action' : p.taxableSupplies === 'no' ? 'not_applicable' : 'review',
    p.vatRegistered === 'yes' ? monthlyDeadline(today, rules.vat.dueDay) : null);
  add('etims', true, p.etimsRegistered === 'yes' ? 'registered' : 'review');
  add('permit', null, 'review', p.permitExpiry || null, rules.counties[p.county]?.source || null);
  add('annual', null, p.legalStructure === 'unknown' || (p.legalStructure === 'company' && !p.accountingYearEndMonth) ? 'unknown' : 'review', annualDeadline(p, today));
  const missingFields = ['legalStructure', 'activity', 'county', 'hasKraPin', 'estimatedAnnualTurnover', 'resident', 'totExcludedIncome', 'totElectionOut', 'taxableSupplies']
    .filter(key => p[key] === 'unknown' || p[key] === '' || p[key] === null);
  return { profile: p, items, missingFields, ledger, evaluatedOn: today, rulesVersion: rules.version, reviewedOn: rules.reviewedOn };
}

export function noticeCandidates(assessment) {
  const { profile: p, items, evaluatedOn: today, ledger } = assessment;
  const text = rules.text[p.reportLanguage] || rules.text.en;
  const candidates = [];
  for (const item of items) {
    if (item.deadline) {
      const days = (Date.parse(item.deadline) - Date.parse(today)) / 86400000;
      if (days >= 0 && days <= rules.reminderDays) candidates.push({ key: `${item.id}:deadline:${item.deadline}`, obligation: item.id, kind: 'deadline', deadline: item.deadline, message: `${text.reminder}: ${item.title}. ${item.deadline}. ${text.notice}` });
    }
  }
  for (const [id, amount, period, threshold, crossed] of [
    ['tot', ledger.calendarYearRevenue, ledger.calendarYear, rules.tot.minimumExclusive, ledger.calendarYearRevenue > rules.tot.minimumExclusive],
    ['vat', ledger.trailing12MonthRevenue, 'once', rules.vat.minimumInclusive, ledger.trailing12MonthRevenue >= rules.vat.minimumInclusive],
  ]) {
    const item = items.find(i => i.id === id);
    const excluded = id === 'tot' ? p.resident === 'no' || p.totExcludedIncome === 'yes' || p.totElectionOut === 'yes' || Math.max(p.estimatedAnnualTurnover || 0, ledger.calendarYearRevenue || 0) > rules.tot.maximumInclusive : p.taxableSupplies === 'no';
    if ((crossed || item.status === 'action') && item.status !== 'registered' && !excluded) {
      candidates.push({ key: `${id}:threshold:${period}:${threshold}`, obligation: id, kind: 'threshold', deadline: null,
        message: `${text.threshold}: ${item.title}. KSh ${threshold.toLocaleString('en-KE')}. ${text.notice}`, recordedRevenue: amount });
    }
  }
  return candidates;
}
