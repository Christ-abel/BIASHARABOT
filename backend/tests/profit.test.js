import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeeklyReport,
  computeItemProfits,
  formatItemProfitSms,
  groupSoldProducts,
  normalizeItemName,
  resolveUnitCost
} from '../profit.js';

const sale = (item, qty, unitPrice, extra = {}) => ({
  type: 'sale',
  item,
  qty,
  unit_price: unitPrice,
  total: qty * unitPrice,
  source: 'text',
  matched: false,
  ...extra
});

const purchase = (item, qty, unitPrice, extra = {}) => ({
  type: 'purchase',
  item,
  qty,
  unit_price: unitPrice,
  total: qty * unitPrice,
  source: extra.source || 'text',
  ...extra
});

const lot = (item, qty, unit_cost) => ({ item, qty, unit_cost, total: qty * unit_cost });

describe('item-level gross profit', () => {
  it('normalizes names so Sugar and sugar 2kg can match', () => {
    assert.equal(normalizeItemName('  Sugar  2kg '), 'sugar 2kg');
    assert.equal(resolveUnitCost('sugar', [lot('Sugar 2kg', 10, 280)]), 280);
    assert.equal(resolveUnitCost('Cooking Oil 1L', [lot('oil', 12, 250)]), 250);
  });

  it('matches ugali sales to maize-flour stock so profit uses the bought cost', () => {
    const cost = resolveUnitCost('Ugali', [lot('Maize Flour 2kg', 20, 150)]);
    assert.equal(cost, 150);
    const rows = computeItemProfits([sale('Ugali', 2, 30)], [lot('Maize Flour 2kg', 20, 150)]);
    assert.equal(rows[0].cogs, 300);
    assert.equal(rows[0].gross_profit, -240);
    assert.equal(rows[0].cost_unknown, false);
  });

  it('uses the weighted-average unit cost across purchase lots', () => {
    const cost = resolveUnitCost('sugar', [
      lot('Sugar', 10, 200),
      lot('Sugar', 10, 300)
    ]);
    assert.equal(cost, 250);
  });

  it('returns null when no stock lot matches — never invents a free cost', () => {
    assert.equal(resolveUnitCost('Mandazi', [lot('Sugar', 10, 280)]), null);
  });

  it('computes gross profit and margin per sold item', () => {
    const rows = computeItemProfits(
      [sale('Sugar', 4, 400)],
      [lot('Sugar', 10, 280)]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cogs, 1120);
    assert.equal(rows[0].revenue, 1600);
    assert.equal(rows[0].gross_profit, 480);
    assert.equal(rows[0].margin, 30);
    assert.equal(rows[0].cost_unknown, false);
  });

  it('marks sold items with no stock cost instead of treating them as free', () => {
    const rows = computeItemProfits([sale('Chapati', 10, 30)], []);
    assert.equal(rows[0].cost_unknown, true);
    assert.equal(rows[0].gross_profit, null);
  });

  it('keeps cash-basis net profit as revenue − purchases − expenses − fees', () => {
    const report = buildWeeklyReport(
      [
        sale('Sugar', 5, 400),
        purchase('Sugar', 10, 280, { source: 'stock' }),
        { type: 'expense', item: 'Rent', qty: 1, unit_price: 1000, total: 1000, source: 'text' },
        { type: 'expense', item: 'M-Pesa Fee', qty: 1, unit_price: 20, total: 20, source: 'payhero' },
        { type: 'credit', item: 'Mama', qty: 1, unit_price: 200, total: 200, source: 'text', matched: false }
      ],
      [lot('Sugar', 10, 280)]
    );

    // 2000 − 2800 − 1000 − 20 = −1820. Unchanged from the pre-stock formula.
    assert.equal(report.revenue, 2000);
    assert.equal(report.cost_of_goods, 2800);
    assert.equal(report.other_expenses, 1000);
    assert.equal(report.mpesa_fees, 20);
    assert.equal(report.net_profit, -1820);
    assert.equal(report.outstanding_credit, 200);

    // Accrual-style: 5 × 280 = 1400 COGS, gross 600.
    assert.equal(report.item_cogs, 1400);
    assert.equal(report.gross_profit, 600);
    assert.equal(report.gross_margin, 30);
    assert.equal(report.items_missing_cost, 0);
  });

  it('does not let unpriced sales inflate overall gross profit', () => {
    const report = buildWeeklyReport(
      [sale('Sugar', 2, 400), sale('Unknown Snack', 1, 1000)],
      [lot('Sugar', 10, 200)]
    );
    assert.equal(report.gross_profit, 400);
    assert.equal(report.items_missing_cost, 1);
    assert.equal(report.unpriced_revenue, 1000);
  });

  it('groups sold products with quantity, unit price and line total', () => {
    const rows = groupSoldProducts([
      sale('Sugar 2kg', 2, 200),
      sale('sugar 2kg', 1, 200),
      sale('Oil', 1, 450)
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].item, 'Sugar 2kg');
    assert.equal(rows[0].qty, 3);
    assert.equal(rows[0].unit_price, 200);
    assert.equal(rows[0].total, 600);
    assert.equal(buildWeeklyReport([sale('Sugar 2kg', 3, 200)]).sold_items[0].total, 600);
  });

  it('formats a compact SMS addendum with overall and top item margins', () => {
    const report = buildWeeklyReport(
      [sale('Sugar', 4, 400), sale('Oil', 2, 350)],
      [lot('Sugar', 10, 280), lot('Oil', 12, 250)]
    );
    const sms = formatItemProfitSms(report);
    assert.match(sms, /Gross Profit: KSh /);
    assert.match(sms, /Sugar/);
    assert.match(sms, /Oil/);
  });
});
