import { randomUUID } from 'node:crypto';
import Entry from './models/Entry.js';
import Stock from './models/Stock.js';

/**
 * YYYY-MM-DD from the review form is a calendar date, not a UTC midnight.
 * Parsing it with `new Date('2026-03-28')` would shift to the previous
 * evening in Kenya (UTC+3) and put the purchase on the wrong day.
 */
function resolvePurchaseDate(value) {
  if (!value) return new Date();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed > new Date() ? new Date() : parsed;
}

/**
 * Write each reviewed stock line as a Stock lot *and* a purchase Entry.
 *
 * Existing voice/text purchase entries keep working. Stock also writes a
 * matching purchase so the weekly cash-basis "cost of goods" total still
 * includes what the owner just bought. The two rows share entry_id so we
 * can tell they are the same event.
 */
export async function persistStockLots({
  businessId,
  items,
  source,
  supplier = '',
  purchaseDate = null,
  receiptId = null
}) {
  const bid = businessId || 'demo-shop';
  const groupedReceiptId = source === 'receipt' ? (receiptId || randomUUID()) : null;
  const safeDate = resolvePurchaseDate(purchaseDate);
  const saved = [];

  for (const line of items) {
    const transcription = source === 'receipt'
      ? `Stock from receipt${supplier ? ` (${supplier})` : ''}: ${line.item}`
      : `Manual stock: ${line.item}`;

    const entry = new Entry({
      business_id: bid,
      type: 'purchase',
      item: line.item,
      qty: line.qty,
      unit_price: line.unit_cost,
      total: line.total,
      source: 'stock',
      transcription,
      matched: true,
      timestamp: safeDate
    });
    await entry.save();

    const lot = new Stock({
      business_id: bid,
      item: line.item,
      qty: line.qty,
      unit_cost: line.unit_cost,
      total: line.total,
      supplier: supplier || '',
      purchase_date: safeDate,
      source,
      receipt_id: groupedReceiptId || undefined,
      entry_id: entry._id
    });
    await lot.save();

    saved.push({ stock: lot, entry });
  }

  return {
    receipt_id: groupedReceiptId,
    count: saved.length,
    lots: saved.map(({ stock }) => stock)
  };
}
