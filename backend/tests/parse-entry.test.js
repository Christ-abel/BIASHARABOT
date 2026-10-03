import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachPhrases,
  coerceParsedEntries,
  parseShopTalk,
  peelCreditParty,
  phraseEntry
} from '../parse-entry.js';

describe('Kenyan shop-talk parser', () => {
  it('splits Ugali twenty bob and nyama thirty bob into two sales', () => {
    const rows = parseShopTalk('Ugali twenty bob, nyama thirty bob');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].item, 'Ugali');
    assert.equal(rows[0].qty, 1);
    assert.equal(rows[0].unit_price, 20);
    assert.equal(rows[1].item, 'Nyama');
    assert.equal(rows[1].unit_price, 30);
    assert.equal(rows[0].type, 'sale');
  });

  it('keeps pack size in the name and uses the last number as price', () => {
    const [row] = parseShopTalk('sold 3 sugar 2kg at 280');
    assert.equal(row.item, 'Sugar 2kg');
    assert.equal(row.qty, 3);
    assert.equal(row.unit_price, 280);
    assert.equal(row.total, 840);
  });

  it('reads sold 10 loaves at 50 each', () => {
    const [row] = parseShopTalk('sold 10 loaves at 50 each');
    assert.equal(row.item, 'Loaves');
    assert.equal(row.qty, 10);
    assert.equal(row.unit_price, 50);
    assert.equal(row.total, 500);
  });

  it('reads Swahili number words', () => {
    const rows = parseShopTalk('nimeuza ugali ishirini na nyama thelathini');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].item, 'Ugali');
    assert.equal(rows[0].unit_price, 20);
    assert.equal(rows[1].item, 'Nyama');
    assert.equal(rows[1].unit_price, 30);
  });

  it('writes the sale in the owner language', () => {
    const en = phraseEntry({ type: 'sale', item: 'Ugali', qty: 1, unit_price: 20, total: 20 }, 'en');
    const sw = phraseEntry({ type: 'sale', item: 'Ugali', qty: 1, unit_price: 20, total: 20 }, 'sw');
    assert.equal(en, 'Ugali was sold for KSh 20');
    assert.equal(sw, 'Ugali iliuza kwa KSh 20');
    const phrases = attachPhrases(parseShopTalk('Ugali twenty bob'), 'en');
    assert.equal(phrases[0].transcription, 'Ugali was sold for KSh 20');
  });

  it('reads kopesha mama sugar 50 with a Kenyan phone as credit', () => {
    const [row] = parseShopTalk('kopesha mama sugar 50 0712345678');
    assert.equal(row.type, 'credit');
    assert.equal(row.item, 'Sugar');
    assert.equal(row.unit_price, 50);
    assert.equal(row.customer_name, 'Mama');
    assert.equal(row.customer_phone, '254712345678');
  });

  it('reads sugar 50 on credit for Amina', () => {
    const [row] = parseShopTalk('sugar 50 on credit for Amina 0112345678');
    assert.equal(row.type, 'credit');
    assert.equal(row.item, 'Sugar');
    assert.equal(row.unit_price, 50);
    assert.equal(row.customer_name, 'Amina');
    assert.equal(row.customer_phone, '254112345678');
  });

  it('does not treat the product as the customer on nimekopesha sugar 50', () => {
    const party = peelCreditParty('nimekopesha sugar 50');
    assert.equal(party.name, '');
    const [row] = parseShopTalk('nimekopesha sugar 50');
    assert.equal(row.type, 'credit');
    assert.equal(row.item, 'Sugar');
    assert.equal(row.customer_name, '');
  });

  it('names the customer on a credit phrase', () => {
    const en = phraseEntry({
      type: 'credit',
      item: 'Sugar',
      qty: 1,
      unit_price: 50,
      total: 50,
      customer_name: 'Mama'
    }, 'en');
    assert.equal(en, 'Sugar on credit for Mama, KSh 50');
  });

  it('accepts a Gemini-style items array', () => {
    const rows = coerceParsedEntries({
      items: [
        { type: 'sale', item: 'Ugali', qty: 1, unit_price: 20, total: 20 },
        { type: 'sale', item: 'Nyama', qty: 1, unit_price: 30, total: 30 }
      ]
    }, 'Ugali twenty bob, nyama thirty bob', 'en');
    assert.equal(rows.length, 2);
    assert.match(rows[0].transcription, /Ugali was sold/);
  });
});
