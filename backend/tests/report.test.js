import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_LABELS_EN,
  REPORT_LABEL_KEYS,
  buildReportMessage,
  computeReportFigures,
  formatAmount,
  isSupportedLanguage
} from '../report.js';

const sampleEntries = [
  { type: 'sale', total: 1500, source: 'voice' },
  { type: 'sale', total: '250.5', source: 'text' },
  { type: 'sale', total: undefined, source: 'text' }, // bad parse must not poison the sums
  { type: 'purchase', total: 700, source: 'text' },
  { type: 'expense', total: 120, source: 'voice' },
  { type: 'expense', total: 15, source: 'payhero' }, // M-Pesa fee
  { type: 'credit', total: 300, matched: false },
  { type: 'credit', total: 900, matched: true } // already settled
];

const swLabels = {
  title_weekly: 'Ripoti ya Wiki ya BiasharaGPT',
  title_daily: 'Ripoti ya Siku ya BiasharaGPT',
  shop: 'Duka',
  revenue: 'Mapato',
  cost_of_goods: 'Gharama ya Bidhaa',
  other_expenses: 'Matumizi Mengine',
  mpesa_fees: 'Ada za M-Pesa',
  net_profit: 'Faida Halisi',
  outstanding_credit: 'Deni Linalodaiwa',
  printed_at: 'Imechapishwa tarehe',
  footer: 'Inaendeshwa na BiasharaGPT!'
};

const amountsIn = (text) => text.match(/KSh -?\d+\.\d{2}/g) || [];

describe('computeReportFigures', () => {
  test('sums each category and ignores entries without a numeric total', () => {
    const figures = computeReportFigures(sampleEntries);
    assert.deepEqual(figures, {
      revenue: 1750.5,
      cost_of_goods: 700,
      other_expenses: 120,
      mpesa_fees: 15,
      net_profit: 1750.5 - 700 - 120 - 15,
      outstanding_credit: 300
    });
  });

  test('returns zeros for an empty ledger', () => {
    const figures = computeReportFigures([]);
    assert.ok(Object.values(figures).every((v) => v === 0));
  });
});

describe('buildReportMessage', () => {
  test('uses English labels by default and the weekly title', () => {
    const message = buildReportMessage({ businessName: 'My Duka', ...computeReportFigures(sampleEntries) });
    assert.match(message, /^BiasharaGPT Weekly Report\n/);
    assert.match(message, /Shop: My Duka/);
    assert.match(message, /Net Profit: KSh 915\.50/);
    assert.match(message, /Powered by BiasharaGPT!$/);
  });

  test('switches title by label key', () => {
    const message = buildReportMessage({ title: 'title_daily', businessName: 'X', ...computeReportFigures([]) });
    assert.match(message, /^BiasharaGPT Daily Report\n/);
  });

  test('keeps every KSh amount identical across languages', () => {
    const figures = computeReportFigures(sampleEntries);
    const en = buildReportMessage({ businessName: 'Otieno Wholesalers', ...figures });
    const sw = buildReportMessage({ businessName: 'Otieno Wholesalers', labels: swLabels, ...figures });

    assert.notEqual(en, sw);
    assert.equal(amountsIn(en).length, 6);
    assert.deepEqual(amountsIn(sw), amountsIn(en));
    assert.match(sw, /Duka: Otieno Wholesalers/);
    assert.match(sw, /Faida Halisi: KSh 915\.50/);
  });

  test('fills any label missing from a partial translation with English', () => {
    const message = buildReportMessage({ businessName: 'X', labels: { revenue: 'Mapato' }, ...computeReportFigures([]) });
    assert.match(message, /Mapato: KSh 0\.00/);
    assert.match(message, /Net Profit: KSh 0\.00/);
  });
});

describe('helpers', () => {
  test('formatAmount always shows two decimals and tolerates junk', () => {
    assert.equal(formatAmount(1234.5), 'KSh 1234.50');
    assert.equal(formatAmount('12'), 'KSh 12.00');
    assert.equal(formatAmount(undefined), 'KSh 0.00');
    assert.equal(formatAmount(NaN), 'KSh 0.00');
  });

  test('isSupportedLanguage only accepts known codes', () => {
    assert.equal(isSupportedLanguage('en'), true);
    assert.equal(isSupportedLanguage('sw'), true);
    assert.equal(isSupportedLanguage('fr'), false);
    assert.equal(isSupportedLanguage('toString'), false);
    assert.equal(isSupportedLanguage(undefined), false);
  });

  test('English label set covers every key the template needs', () => {
    for (const key of REPORT_LABEL_KEYS) {
      assert.equal(typeof REPORT_LABELS_EN[key], 'string');
    }
  });
});
