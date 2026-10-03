/**
 * Server-side support for entries the PWA captured with no network.
 *
 * Offline capture breaks two assumptions the online path could make:
 *   - an upload can arrive more than once, because the app and its service
 *     worker both retry, so `clientId` acts as an idempotency key;
 *   - the transaction happened earlier than the request that carries it, so
 *     `occurredAt` is the time that belongs in the ledger.
 */

import Entry from './models/Entry.js';

const RECONCILE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** @returns the entry already stored for this idempotency key, if any. */
export async function findByClientId(clientId) {
  if (!clientId) return null;
  return Entry.findOne({ client_id: clientId });
}

/** The time the transaction happened, not the time its upload arrived. */
export function resolveTimestamp(occurredAt) {
  if (!occurredAt) return new Date();
  const when = new Date(occurredAt);
  if (isNaN(when.getTime())) return new Date();
  // Ignore clock-skewed phones claiming the future.
  return when > new Date() ? new Date() : when;
}

/**
 * Saves an entry, tolerating the race where a duplicate upload slips past the
 * pre-check: the unique index on client_id rejects it and the entry that was
 * stored first is returned instead.
 *
 * @returns {Promise<{entry: object, duplicate: boolean}>}
 */
export async function saveEntryIdempotently(entry, clientId) {
  try {
    await entry.save();
    return { entry, duplicate: false };
  } catch (error) {
    if (error.code === 11000 && clientId) {
      const existing = await findByClientId(clientId);
      if (existing) {
        console.log(`[IDEMPOTENT] Duplicate upload for clientId ${clientId} ignored`);
        return { entry: existing, duplicate: true };
      }
    }
    throw error;
  }
}

/**
 * Reconciles a late-arriving offline sale against the M-Pesa payment that paid
 * for it.
 *
 * Order of events in a dead spot: the shopkeeper records the sale on the phone,
 * the customer pays by M-Pesa, and PayHero's webhook reaches the server first.
 * With no ledger entry to match, that webhook logs a placeholder "M-Pesa
 * Payment" sale. Once the real entry finally uploads, the same shilling would
 * be counted twice — so the placeholder is absorbed here: the real entry is
 * marked paid and keeps the placeholder's id for the audit trail.
 */
export async function reconcileOfflineSale(entry) {
  if (entry.type !== 'sale' || entry.matched) return entry;

  const occurredAt = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
  const placeholder = await Entry.findOne({
    // The webhook cannot always tell which business a spontaneous payment
    // belongs to and falls back to 'demo-shop', so accept both.
    business_id: { $in: [entry.business_id, 'demo-shop'] },
    type: 'sale',
    source: 'payhero',
    matched: false,
    total: entry.total,
    timestamp: {
      $gte: new Date(occurredAt - RECONCILE_WINDOW_MS),
      $lte: new Date(Date.now() + 60_000)
    }
  }).sort({ timestamp: 1 });

  if (!placeholder) return entry;

  entry.matched = true;
  entry.reconciled_from = placeholder._id.toString();
  await entry.save();
  await Entry.deleteOne({ _id: placeholder._id });

  console.log(
    `[RECONCILIATION] Offline sale ${entry._id} (KSh ${entry.total}) absorbed ` +
    `placeholder M-Pesa payment ${placeholder._id}`
  );
  return entry;
}
