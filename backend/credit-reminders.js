/**
 * Customer-credit SMS: when the duka lends goods (sugar for 50, pay later),
 * ping the client after three days. Small shops restock weekly; unpaid deni
 * is money they cannot take to the supplier.
 */

import Business from './models/Business.js';
import Entry from './models/Entry.js';
import { normalizeReportLanguage } from './languages.js';
import { sendSMS } from './sms.js';

export const CREDIT_REMINDER_GAP_MS = 3 * 24 * 60 * 60 * 1000;

function money(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function creditReminderIsDue({ lentAt, lastReminderAt, matched, now = new Date() }) {
  if (matched) return false;
  if (!lentAt) return false;
  const current = now instanceof Date ? now : new Date(now);
  if (current - new Date(lentAt) < CREDIT_REMINDER_GAP_MS) return false;
  if (lastReminderAt && current - new Date(lastReminderAt) < CREDIT_REMINDER_GAP_MS) return false;
  return true;
}

export function buildCreditReminder({
  shopName,
  item,
  amount,
  customerName,
  language,
  toCustomer = true
}) {
  const shop = String(shopName || 'the shop').trim() || 'the shop';
  const goods = String(item || 'goods').trim() || 'goods';
  const kes = money(amount);
  const who = String(customerName || 'the customer').trim() || 'the customer';
  const sw = normalizeReportLanguage(language) === 'sw';

  if (toCustomer) {
    return sw
      ? `${shop}: ulichukua ${goods} kwa deni, KSh ${kes}. Tafadhali lipa ili tununue stock wiki hii. Asante.`
      : `${shop}: you took ${goods} on credit, KSh ${kes}. Please pay so we can restock this week. Asante.`;
  }

  return sw
    ? `${shop}: ${who} bado hajalipa KSh ${kes} ya ${goods} (siku 3). Wakumbushe ili ununue stock.`
    : `${shop}: ${who} still owes KSh ${kes} for ${goods} (3 days). Remind them so you can restock.`;
}

export async function runCreditReminders({ send = sendSMS, now = new Date() } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const cutoff = new Date(current.getTime() - CREDIT_REMINDER_GAP_MS);
  const credits = await Entry.find({
    type: 'credit',
    matched: { $ne: true },
    timestamp: { $lte: cutoff }
  }).lean();

  const shopIds = [...new Set(credits.map((row) => row.business_id).filter(Boolean))];
  const shops = shopIds.length
    ? await Business.find({ id: { $in: shopIds } }).select('id name phone reportLanguage').lean()
    : [];
  const shopById = new Map(shops.map((shop) => [shop.id, shop]));

  const sent = [];
  let skipped = 0;

  for (const credit of credits) {
    if (!creditReminderIsDue({
      lentAt: credit.timestamp,
      lastReminderAt: credit.lastCreditReminderAt,
      matched: credit.matched,
      now: current
    })) {
      skipped += 1;
      continue;
    }

    const shop = shopById.get(credit.business_id);
    const toCustomer = Boolean(credit.customer_phone);
    const to = credit.customer_phone || shop?.phone || '';
    if (!to) {
      skipped += 1;
      continue;
    }

    const message = buildCreditReminder({
      shopName: shop?.name,
      item: credit.item,
      amount: credit.total,
      customerName: credit.customer_name,
      language: shop?.reportLanguage,
      toCustomer
    });
    const result = await send({ to, message });
    if (result?.success) {
      await Entry.updateOne({ _id: credit._id }, { $set: { lastCreditReminderAt: current } });
      sent.push(String(credit._id));
    }
  }

  if (sent.length) {
    console.log(`[CREDIT REMINDER] SMS sent for ${sent.length} unpaid credit(s)`);
  }
  return {
    checked: credits.length,
    sent: sent.length,
    skipped,
    entryIds: sent
  };
}
