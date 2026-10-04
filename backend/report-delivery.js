/**
 * Till-slip reports and their SMS delivery.
 *
 * Viewing a report never sends anything. An SMS goes out only when:
 *   - the scheduled weekly job runs (runWeeklyReportJob), at most once per
 *     shop per week, or
 *   - the logged-in owner taps "Send to my phone" (trigger: 'manual').
 * Either way it goes to the phone saved on the shop, never to a number
 * supplied by the request.
 */

import Business from './models/Business.js';
import Entry from './models/Entry.js';
import Stock from './models/Stock.js';
import ReportDelivery from './models/ReportDelivery.js';
import { buildWeeklyReport } from './profit.js';
import { assembleLocalizedReport, normalizeReportLanguage } from './report.js';
import { REPORT_LABELS } from './report-labels.js';
import { filterEntriesByKenyaRange, formatKenyaPeriod, kenyaWeekRange } from './kenya-dates.js';
import { translatePhrasesWithGemini } from './gemini.js';
import { sendSMS } from './services/sms.js';

/** A failed scheduled send is retried by later runs, up to this many tries. */
export const MAX_SCHEDULED_ATTEMPTS = 3;

/**
 * Builds the till slip for one shop: a single day when `date` is given,
 * otherwise the seven Kenyan days ending on `asOf`.
 */
export async function buildShopReport(biz, { date, language, asOf = new Date(), businessName } = {}) {
  const bid = biz?.id || 'demo-shop';
  const bname = biz?.name || businessName || 'My Duka';
  const lang = normalizeReportLanguage(language || biz?.reportLanguage);
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
  const period = day ? { start: day, end: day } : kenyaWeekRange(asOf);
  const periodLabel = formatKenyaPeriod(period.start, period.end);

  const [allEntries, stockLots] = await Promise.all([
    Entry.find({ business_id: bid }),
    Stock.find({ business_id: bid })
  ]);
  const entries = filterEntriesByKenyaRange(allEntries, period.start, period.end);

  // Cash-basis totals keep the same formula as before. Item-level gross
  // profit is computed from stock unit costs and sits beside them.
  const report = buildWeeklyReport(entries, stockLots);
  const localized = await assembleLocalizedReport({
    report,
    businessName: bname,
    shopPhone: biz?.phone || '',
    tillNumber: biz?.tillNumber || '',
    periodLabel,
    title: day ? (REPORT_LABELS[lang]?.dailyTitle || REPORT_LABELS.en.dailyTitle) : undefined,
    language: lang,
    translate: translatePhrasesWithGemini
  });

  return { bid, bname, day, period, periodLabel, entryCount: entries.length, localized };
}

export function weeklyDedupeKey(businessId, period) {
  return `weekly:${businessId}:${period.start}:${period.end}`;
}

/**
 * Claims the right to send this week's scheduled SMS. Returns the claimed
 * row, or null when it was already sent, is being sent by another run, or
 * has used up its retries.
 */
export async function claimScheduledDelivery(store, { businessId, period }) {
  const dedupeKey = weeklyDedupeKey(businessId, period);
  try {
    return await store.create({
      business_id: businessId,
      trigger: 'schedule',
      period_start: period.start,
      period_end: period.end,
      dedupe_key: dedupeKey,
      status: 'sending',
      attempts: 1
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Someone already holds this week. Only a failed attempt with retries
    // left can be taken over, and only atomically.
    return store.findOneAndUpdate(
      { dedupe_key: dedupeKey, status: 'failed', attempts: { $lt: MAX_SCHEDULED_ATTEMPTS } },
      { $set: { status: 'sending', error: null, error_code: null }, $inc: { attempts: 1 } },
      { new: true }
    );
  }
}

/**
 * Sends one shop's till slip by SMS and records the outcome.
 *
 * @returns {Promise<{outcome: 'sent'|'failed'|'skipped'|'quiet', delivery?: object, sms?: object, reason?: string}>}
 */
export async function sendShopReportSms(biz, {
  trigger,
  date,
  asOf = new Date(),
  store = ReportDelivery,
  send = sendSMS,
  buildReport = buildShopReport,
  allowEmpty = false
} = {}) {
  if (!biz?.id) throw new Error('A saved shop is required to send its report');
  if (!biz.phone) return { outcome: 'failed', reason: 'no_phone' };

  const built = await buildReport(biz, { date: trigger === 'schedule' ? undefined : date, asOf });

  // A shop that logged nothing this week does not need to pay for an SMS of zeros.
  if (trigger === 'schedule' && built.entryCount === 0 && !allowEmpty) {
    return { outcome: 'quiet', reason: 'no_entries' };
  }

  const delivery = trigger === 'schedule'
    ? await claimScheduledDelivery(store, { businessId: biz.id, period: built.period })
    : await store.create({
      business_id: biz.id,
      trigger: 'manual',
      period_start: built.period.start,
      period_end: built.period.end,
      status: 'sending'
    });

  if (!delivery) return { outcome: 'skipped', reason: 'already_sent' };

  const sms = await send({ to: biz.phone, message: built.localized.sms });

  await store.updateOne(
    { _id: delivery._id },
    {
      $set: {
        status: sms.success ? 'sent' : 'failed',
        to: sms.to,
        parts: sms.parts,
        mock: Boolean(sms.mock),
        ref_id: sms.msgId,
        error: sms.success ? null : sms.error || 'SMS failed',
        error_code: sms.success ? null : sms.code || null,
        sent_at: sms.success ? new Date() : null
      }
    }
  );

  return { outcome: sms.success ? 'sent' : 'failed', delivery, sms, built };
}

let jobRunning = false;

/**
 * Weekly till-slip run for every shop. Safe to trigger more than once for the
 * same week: each shop's claim is unique, so a repeat run only retries the
 * sends that failed.
 */
export async function runWeeklyReportJob({
  asOf = new Date(),
  listBusinesses = () => Business.find({}).cursor(),
  trigger = 'schedule',
  ...options
} = {}) {
  if (jobRunning) return { skipped: 'already_running' };
  jobRunning = true;

  const summary = { period: kenyaWeekRange(asOf), sent: 0, failed: 0, skipped: 0, quiet: 0, errors: 0 };
  try {
    for await (const biz of listBusinesses()) {
      try {
        const result = await sendShopReportSms(biz, { ...options, trigger, asOf });
        summary[result.outcome] += 1;
      } catch (error) {
        summary.errors += 1;
        console.error(`[WEEKLY JOB] Shop ${biz?.id} failed:`, error?.message || error);
      }
    }
    console.log('[WEEKLY JOB] Finished', JSON.stringify(summary));
    return summary;
  } finally {
    jobRunning = false;
  }
}
