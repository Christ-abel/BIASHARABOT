import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateStockItem, validateStockBatch } from '../stock-validation.js';

describe('manual stock entry validation', () => {
  it('accepts a complete typed line and trims the item name', () => {
    const result = validateStockItem({
      item: '  Cooking Oil  ',
      qty: 12,
      unit_cost: 250,
      total: 3000
    });
    assert.equal(result.ok, true);
    assert.equal(result.item.item, 'Cooking Oil');
    assert.equal(result.item.qty, 12);
    assert.equal(result.item.unit_cost, 250);
    assert.equal(result.item.total, 3000);
    assert.equal(result.item.pieces_per_pack, 1);
  });

  it('keeps how many pieces a bought pack is sold as', () => {
    const result = validateStockItem({
      item: 'Bar Soap',
      qty: 10,
      unit_cost: 80,
      pieces_per_pack: 4
    });
    assert.equal(result.ok, true);
    assert.equal(result.item.pieces_per_pack, 4);
  });

  it('rejects a blank item name', () => {
    const result = validateStockItem({ item: '   ', qty: 2, unit_cost: 50 });
    assert.equal(result.ok, false);
    assert.match(result.error, /item name/i);
  });

  it('rejects zero or negative quantity', () => {
    assert.equal(validateStockItem({ item: 'Sugar', qty: 0, unit_cost: 280 }).ok, false);
    assert.equal(validateStockItem({ item: 'Sugar', qty: -3, unit_cost: 280 }).ok, false);
    assert.equal(validateStockItem({ item: 'Sugar', qty: 'abc', unit_cost: 280 }).ok, false);
  });

  it('rejects a negative unit cost', () => {
    const result = validateStockItem({ item: 'Sugar', qty: 2, unit_cost: -10 });
    assert.equal(result.ok, false);
    assert.match(result.error, /negative/i);
  });

  it('rejects a line with neither unit cost nor total', () => {
    const result = validateStockItem({ item: 'Sugar', qty: 5 });
    assert.equal(result.ok, false);
    assert.match(result.error, /cost/i);
  });

  it('rejects an empty confirm batch so nothing is written', () => {
    assert.equal(validateStockBatch([]).ok, false);
    assert.equal(validateStockBatch(null).ok, false);
  });

  it('fails the whole confirm batch when one reviewed row is invalid', () => {
    const result = validateStockBatch([
      { item: 'Sugar', qty: 10, unit_cost: 280, total: 2800 },
      { item: 'Oil', qty: 2, unit_cost: 250, total: 10 }
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /Oil/);
  });

  it('accepts a batch the owner has already corrected', () => {
    const result = validateStockBatch([
      { item: 'Sugar', qty: 10, unit_cost: 280 },
      { item: 'Oil', qty: 12, unit_cost: 250 }
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[1].total, 3000);
  });
});
