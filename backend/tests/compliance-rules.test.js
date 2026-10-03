import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_CONFIG } from '../compliance-config.js';
import {
  evaluateCompliance,
  nextAnnualDeadline,
  nextMonthlyDeadline,
  shouldSendNotice,
  trailingTurnover
} from '../compliance-rules.js';
import { buildNoticeMessage } from '../compliance-notices.js';
import { COMPLIANCE_LABELS } from '../report-labels.js';

const sale = (total, daysAgo, asOf = new Date('2026-10-03T12:00:00')) => ({
  type: 'sale',
  total,
  timestamp: new Date(asOf.getTime() - daysAgo * 86400000)
});

describe('compliance rules mapping', () => {
  const asOf = new Date('2026-10-03T12:00:00');

  it('asks every shop to get a KRA PIN until they say they have one', () => {
    const result = evaluateCompliance({
      profile: { kraPin: 'unknown', county: '' },
      entries: [],
      asOf
    });
    const pin = result.obligations.find((row) => row.id === 'kra_pin');
    assert.equal(pin.applies, true);
    assert.equal(pin.status, 'action_needed');
    assert.equal(result.profileIncomplete, true);
  });

  it('does not put a kiosk on TOT or VAT below the bands', () => {
    const result = evaluateCompliance({
      profile: { kraPin: 'yes', county: 'Nairobi', estimatedAnnualTurnover: 400_000 },
      entries: [sale(200_000, 10, asOf)],
      asOf
    });
    assert.equal(result.obligations.find((row) => row.id === 'tot').applies, false);
    assert.equal(result.obligations.find((row) => row.id === 'vat').applies, false);
    assert.equal(result.triggers.length, 0);
  });

  it('switches on TOT when turnover enters the band', () => {
    const result = evaluateCompliance({
      profile: { kraPin: 'yes', county: 'Kisumu', estimatedAnnualTurnover: 1_500_000 },
      entries: [],
      asOf
    });
    const tot = result.obligations.find((row) => row.id === 'tot');
    assert.equal(tot.applies, true);
    assert.equal(result.triggers.some((row) => row.id === 'threshold_tot'), true);
    assert.ok(result.turnover.used >= COMPLIANCE_CONFIG.tot.minTurnover);
  });

  it('triggers VAT once ledger sales cross the threshold', () => {
    const result = evaluateCompliance({
      profile: { kraPin: 'yes', county: 'Nairobi', estimatedAnnualTurnover: 0 },
      entries: [sale(5_200_000, 20, asOf)],
      asOf
    });
    assert.equal(result.obligations.find((row) => row.id === 'vat').applies, true);
    assert.equal(result.triggers.some((row) => row.id === 'threshold_vat'), true);
    assert.equal(result.turnover.ledger12m, 5_200_000);
  });

  it('uses the higher of estimated turnover and trailing ledger sales', () => {
    const result = evaluateCompliance({
      profile: { estimatedAnnualTurnover: 2_000_000 },
      entries: [sale(500_000, 5, asOf)],
      asOf
    });
    assert.equal(result.turnover.used, 2_000_000);
  });

  it('ignores sales older than 12 months when totalling the ledger', () => {
    const total = trailingTurnover([
      sale(100, 10, asOf),
      sale(9999, 400, asOf)
    ], 365, asOf);
    assert.equal(total, 100);
  });

  it('computes the next TOT filing as the 20th of this or next month', () => {
    const before = nextMonthlyDeadline(new Date('2026-10-03T12:00:00'), 20);
    assert.equal(before.getDate(), 20);
    assert.equal(before.getMonth(), 9);
    const after = nextMonthlyDeadline(new Date('2026-10-21T12:00:00'), 20);
    assert.equal(after.getMonth(), 10);
  });

  it('computes the next 30 June income-tax deadline', () => {
    const beforeJune = nextAnnualDeadline(new Date('2026-03-01T12:00:00'), 6, 30);
    assert.equal(beforeJune.getFullYear(), 2026);
    const afterJune = nextAnnualDeadline(new Date('2026-10-03T12:00:00'), 6, 30);
    assert.equal(afterJune.getFullYear(), 2027);
  });
});

describe('compliance no-repeat guard', () => {
  it('sends a window once and refuses the second time', () => {
    const sent = new Set();
    assert.equal(shouldSendNotice(sent, 'tot:2026-10-20'), true);
    sent.add('tot:2026-10-20');
    assert.equal(shouldSendNotice(sent, 'tot:2026-10-20'), false);
    assert.equal(shouldSendNotice(sent, 'tot:2026-11-20'), true);
  });

  it('keeps figures and dates out of Gemini — they are interpolated into a fixed template', () => {
    const message = buildNoticeMessage({
      labels: COMPLIANCE_LABELS.en,
      shopName: 'Otieno Wholesalers',
      obligation: {
        noticeType: 'deadline_approaching',
        titleKey: 'totTitle',
        bodyKey: 'totBody',
        deadline: new Date('2026-10-20T12:00:00'),
        vars: {
          min: 1_000_000,
          max: 25_000_000,
          rate: 3,
          deadline: new Date('2026-10-20T12:00:00')
        }
      }
    });
    assert.match(message, /Turnover Tax/);
    assert.match(message, /1,000,000|1,000,000.00|1000000/);
    assert.match(message, /3%/);
    assert.match(message, /2026/);
  });
});
