import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeReceiptParse,
  validateStockItem,
  TOTAL_TOLERANCE_KES
} from '../stock-validation.js';
import { MOCK_RECEIPT } from '../gemini.js';

describe('receipt parse guard rails', () => {
  it('accepts a well-formed Gemini receipt and keeps every line', () => {
    const result = sanitizeReceiptParse(MOCK_RECEIPT);
    assert.equal(result.ok, true);
    assert.equal(result.supplier, 'Nairobi Wholesalers Ltd');
    assert.equal(result.date, '2026-03-28');
    assert.equal(result.items.length, 4);
    assert.equal(result.items[0].item, 'Sugar 2kg');
    assert.equal(result.items[0].total, 2800);
    assert.equal(result.rejected.length, 0);
  });

  it('rejects a line whose total does not match qty × unit_cost', () => {
    const result = validateStockItem({
      item: 'Sugar',
      qty: 10,
      unit_cost: 280,
      total: 5000
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not match/);
  });

  it('allows one-shilling rounding slack on paper receipts', () => {
    const result = validateStockItem({
      item: 'Oil',
      qty: 3,
      unit_cost: 33.33,
      total: 100
    });
    assert.equal(result.ok, true);
    assert.ok(Math.abs(3 * 33.33 - 100) <= TOTAL_TOLERANCE_KES);
  });

  it('fills in a missing total from qty × unit_cost', () => {
    const result = validateStockItem({ item: 'Soap', qty: 24, unit_cost: 80 });
    assert.equal(result.ok, true);
    assert.equal(result.item.total, 1920);
  });

  it('fills in a missing unit cost from total / qty', () => {
    const result = validateStockItem({ item: 'Flour', qty: 20, total: 3000 });
    assert.equal(result.ok, true);
    assert.equal(result.item.unit_cost, 150);
  });

  it('rejects a receipt when every line has an invalid total', () => {
    const result = sanitizeReceiptParse({
      supplier: 'Bad Slip',
      line_items: [
        { item: 'Sugar', qty: 10, unit_cost: 280, total: 9999 },
        { item: 'Oil', qty: 2, unit_cost: 250, total: 10 }
      ]
    });
    assert.equal(result.ok, false);
    assert.equal(result.rejected.length, 2);
    assert.match(result.error, /invalid total/i);
  });

  it('keeps valid lines and reports the rejected ones as warnings', () => {
    const result = sanitizeReceiptParse({
      supplier: 'Mixed Slip',
      line_items: [
        { item: 'Sugar', qty: 10, unit_cost: 280, total: 2800 },
        { item: 'Mystery', qty: 2, unit_cost: 100, total: 999 }
      ]
    });
    assert.equal(result.ok, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].item, 'Mystery');
  });

  it('rejects an unreadable or empty Gemini payload', () => {
    assert.equal(sanitizeReceiptParse({ error: 'Could not read this receipt.' }).ok, false);
    assert.equal(sanitizeReceiptParse({ line_items: [] }).ok, false);
    assert.equal(sanitizeReceiptParse(null).ok, false);
  });

  it('coerces receipt numbers written as "KSh 1,200"', () => {
    const result = validateStockItem({
      item: 'Rice 5kg',
      qty: '4',
      unit_cost: 'KSh 1,200',
      total: '4,800'
    });
    assert.equal(result.ok, true);
    assert.equal(result.item.unit_cost, 1200);
    assert.equal(result.item.total, 4800);
  });
});
