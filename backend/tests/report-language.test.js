import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_LABELS } from '../report-labels.js';
import {
  assembleLocalizedReport,
  buildReportMessage,
  formatKesAmount,
  resolveReportLabels
} from '../report.js';
import { normalizeReportLanguage } from '../languages.js';

const SAMPLE_REPORT = {
  revenue: 12500.5,
  cost_of_goods: 7300,
  other_expenses: 1200,
  mpesa_fees: 50.25,
  net_profit: 3950.25,
  outstanding_credit: 800,
  gross_profit: 4200,
  gross_margin: 33.6,
  items_missing_cost: 1,
  sold_items: [
    { item: 'Sugar 2kg', qty: 10, unit_price: 200, total: 2000 },
    { item: 'Oil', qty: 2, unit_price: 450, total: 900 }
  ],
  item_profits: [
    { item: 'Sugar 2kg', gross_profit: 1200, margin: 40, cost_unknown: false },
    { item: 'Oil', gross_profit: 800, margin: 25, cost_unknown: false }
  ]
};

const extractAmounts = (text) => text.match(/KSh \d+\.\d{2}/g);

describe('report language', () => {
  it('treats a missing or unknown owner language as English', () => {
    assert.equal(normalizeReportLanguage(undefined), 'en');
    assert.equal(normalizeReportLanguage(null), 'en');
    assert.equal(normalizeReportLanguage(''), 'en');
    assert.equal(normalizeReportLanguage('fr'), 'en');
    assert.equal(normalizeReportLanguage('SW'), 'sw');
  });

  it('serves the fixed Swahili template without calling a translator', async () => {
    let called = 0;
    const resolved = await resolveReportLabels('sw', {
      translate: async () => {
        called += 1;
        throw new Error('should not run');
      }
    });
    assert.equal(called, 0);
    assert.equal(resolved.fallback, false);
    assert.equal(resolved.language, 'sw');
    assert.equal(resolved.labels.netProfit, 'FAIDA HALISI');
    assert.equal(resolved.labels.revenue, 'MAUZO');
  });

  it('keeps KES amounts identical in English and Swahili SMS', async () => {
    const en = await assembleLocalizedReport({
      report: SAMPLE_REPORT,
      businessName: 'Otieno Wholesalers',
      shopPhone: '254712345678',
      tillNumber: '5341163',
      periodLabel: '27 Sep 2026 – 3 Oct 2026',
      language: 'en'
    });
    const sw = await assembleLocalizedReport({
      report: SAMPLE_REPORT,
      businessName: 'Otieno Wholesalers',
      shopPhone: '254712345678',
      tillNumber: '5341163',
      periodLabel: '27 Sep 2026 – 3 Oct 2026',
      language: 'sw'
    });

    assert.deepEqual(extractAmounts(en.sms), extractAmounts(sw.sms));
    assert.match(en.sms, /Weekly Report/);
    assert.match(sw.sms, /Ripoti ya Wiki/);
    assert.match(en.sms, /Otieno Wholesalers/);
    assert.match(sw.sms, /Otieno Wholesalers/);
    assert.match(en.sms, /5341163/);
    assert.match(en.sms, /27 Sep 2026/);
    assert.match(en.sms, /PRODUCTS SOLD/);
    assert.match(sw.sms, /BIDHAA ZILIZOUZWA/);
    assert.match(sw.sms, /Sugar 2kg/);
    assert.equal(formatKesAmount(SAMPLE_REPORT.revenue), 'KSh 12500.50');
  });

  it('falls back to English when translation fails', async () => {
    const resolved = await resolveReportLabels('fr', {
      translate: async () => {
        throw new Error('Gemini 503');
      }
    });
    assert.equal(resolved.fallback, true);
    assert.equal(resolved.language, 'en');
    assert.equal(resolved.fallbackReason, 'Gemini 503');
    assert.deepEqual(resolved.labels, REPORT_LABELS.en);
  });

  it('falls back to English when translation times out', async () => {
    const resolved = await resolveReportLabels('fr', {
      timeoutMs: 25,
      translate: () => new Promise(() => {})
    });
    assert.equal(resolved.fallback, true);
    assert.equal(resolved.language, 'en');
    assert.match(resolved.fallbackReason, /timed out/i);
    assert.equal(resolved.labels.netProfit, REPORT_LABELS.en.netProfit);
  });

  it('falls back to English when there is no translator for an unknown language', async () => {
    const resolved = await resolveReportLabels('fr');
    assert.equal(resolved.fallback, true);
    assert.equal(resolved.language, 'en');
  });

  it('does not let a translator change the formatted amounts', () => {
    const en = buildReportMessage({
      labels: REPORT_LABELS.en,
      businessName: 'Duka',
      ...SAMPLE_REPORT
    });
    const tampered = buildReportMessage({
      labels: { ...REPORT_LABELS.en, revenue: 'TAFSIRI' },
      businessName: 'Duka',
      ...SAMPLE_REPORT
    });
    assert.deepEqual(extractAmounts(en), extractAmounts(tampered));
  });
});
