/**
 * Shop-floor undo: Gemini often hears "sukari" as "yakari". The owner
 * says "cancel that" (or taps Undo) and the bad line is removed so they
 * can say it again.
 */

import Entry from './models/Entry.js';
import { itemFamily, normalizeItemName } from './item-names.js';

const CANCEL_EXACT = [
  'cancel', 'cancel that', 'cancel this', 'cancel it',
  'undo', 'undo that', 'undo this',
  'delete that', 'delete this',
  'futa', 'futa hiyo', 'futa ile', 'futa iyo',
  'siyo hiyo', 'siyo ile', 'that was wrong', 'wrong', 'wrong one'
];

const CANCEL_PREFIX = /^(cancel|undo|delete|futa)(?:\s+(?:that|this|it|hiyo|ile|iyo))?\s+(.+)$/i;

export function detectCancelCommand(text) {
  const lower = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!lower) return null;
  if (CANCEL_EXACT.includes(lower)) return { cancel: true, item: '' };

  const named = lower.match(CANCEL_PREFIX);
  if (!named) return null;
  const rest = String(named[2] || '').trim();
  if (!rest || /\d/.test(rest)) return null;
  if (/\b(?:bob|ksh|kes|shillings)\b/.test(rest)) return null;
  return { cancel: true, item: rest };
}

function namesMatch(entryItem, wanted) {
  const a = normalizeItemName(entryItem);
  const b = normalizeItemName(wanted);
  if (!a || !b) return false;
  if (a === b) return true;
  if (itemFamily(entryItem) && itemFamily(entryItem) === itemFamily(wanted)) return true;
  return a.includes(b) || b.includes(a);
}

export async function cancelLastLogged({ businessId, itemName, ids } = {}) {
  const bid = businessId || 'demo-shop';
  const since = new Date(Date.now() - 30 * 60 * 1000);

  if (Array.isArray(ids) && ids.length) {
    const rows = await Entry.find({
      _id: { $in: ids },
      business_id: bid,
      source: { $in: ['voice', 'text'] }
    });
    if (!rows.length) return { cancelled: [] };
    await Entry.deleteMany({ _id: { $in: rows.map((row) => row._id) } });
    return { cancelled: rows.map((row) => (row.toObject ? row.toObject() : row)) };
  }

  const recent = await Entry.find({
    business_id: bid,
    source: { $in: ['voice', 'text'] },
    timestamp: { $gte: since }
  }).sort({ timestamp: -1 }).limit(20);

  if (!recent.length) return { cancelled: [] };

  let batch = recent;
  if (itemName) {
    const match = recent.find((row) => namesMatch(row.item, itemName));
    if (!match) return { cancelled: [], missing: itemName };
    batch = [match];
  } else {
    const newest = new Date(recent[0].timestamp).getTime();
    batch = recent.filter((row) => Math.abs(new Date(row.timestamp).getTime() - newest) <= 4000);
  }

  await Entry.deleteMany({ _id: { $in: batch.map((row) => row._id) } });
  return { cancelled: batch.map((row) => (row.toObject ? row.toObject() : row)) };
}
