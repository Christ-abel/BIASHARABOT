import ComplianceNotice from './models/ComplianceNotice.js';
import { sendSMS } from './services/sms.js';
import { COMPLIANCE_LABELS, interpolate } from './report-labels.js';
import { formatKesAmount } from './report.js';
import { normalizeReportLanguage } from './languages.js';

function formatDeadline(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-KE', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatVar(key, value) {
  if (value instanceof Date) return formatDeadline(value);
  if ((key === 'min' || key === 'max' || key === 'threshold') && Number.isFinite(Number(value))) {
    return formatKesAmount(value).replace('KSh ', '');
  }
  return value;
}

export function phraseCompliance(labels, key, vars = {}) {
  const prepared = {};
  for (const [name, value] of Object.entries(vars)) {
    prepared[name] = formatVar(name, value);
  }
  return interpolate(labels[key] || '', prepared);
}

export function buildNoticeMessage({ labels, shopName, obligation, trigger }) {
  if (trigger) {
    // The threshold sentence is already a full statement ("Your turnover has
    // entered…"), so it is not squeezed into the "{title} now applies" form.
    return interpolate(labels.thresholdSms, {
      title: phraseCompliance(labels, trigger.titleKey, trigger.vars),
      shop: shopName
    });
  }

  const title = phraseCompliance(labels, obligation.titleKey, obligation.vars);
  const hint = phraseCompliance(labels, obligation.bodyKey, obligation.vars);
  const deadline = formatDeadline(obligation.deadline) || labels.noDeadline;
  const template = obligation.noticeType === 'deadline_approaching'
    ? labels.deadlineSms
    : labels.newObligationSms;

  return interpolate(template, { title, shop: shopName, deadline, hint });
}

function collectOutbound(evaluation) {
  const items = [];
  for (const trigger of evaluation.triggers) {
    items.push({
      obligation_id: trigger.id,
      notice_type: 'threshold_crossed',
      window_key: trigger.windowKey,
      trigger
    });
  }
  for (const obligation of evaluation.obligations) {
    if (!obligation.applies || !obligation.noticeType) continue;
    items.push({
      obligation_id: obligation.id,
      notice_type: obligation.noticeType,
      window_key: obligation.windowKey,
      obligation
    });
  }
  return items;
}

/**
 * Send at most one SMS per obligation per window.
 *
 * The notice row is inserted *before* the SMS goes out, so the unique index
 * decides which of two racing requests sends — the loser gets a duplicate-key
 * error and skips. If the SMS then fails, the row is removed again so the
 * next visit retries instead of the owner silently never being told.
 */
export async function dispatchComplianceNotices({
  business,
  evaluation,
  language,
  send = sendSMS,
  store = ComplianceNotice
}) {
  const lang = normalizeReportLanguage(language || business.reportLanguage);
  const labels = COMPLIANCE_LABELS[lang] || COMPLIANCE_LABELS.en;
  const shopName = business.name || 'Duka';
  const sent = [];
  const skipped = [];
  const failed = [];

  for (const item of collectOutbound(evaluation)) {
    const message = buildNoticeMessage({
      labels,
      shopName,
      obligation: item.obligation,
      trigger: item.trigger
    });

    let record;
    try {
      record = await store.create({
        business_id: business.id,
        obligation_id: item.obligation_id,
        notice_type: item.notice_type,
        window_key: item.window_key,
        language: lang,
        message,
        status: 'sending'
      });
    } catch (error) {
      if (error.code === 11000) {
        skipped.push({ ...item, reason: 'already_sent' });
        continue;
      }
      throw error;
    }

    const sms = await send({ to: business.phone, message });

    if (sms?.success) {
      await store.updateOne(
        { _id: record._id },
        { $set: { status: 'sent', ref_id: sms.msgId, mock: Boolean(sms.mock), sent_at: new Date() } }
      );
      sent.push({ ...item, message, sms, id: record._id });
    } else {
      await store.deleteOne({ _id: record._id });
      failed.push({ ...item, reason: sms?.code || 'sms_failed', error: sms?.error });
    }
  }

  return { sent, skipped, failed, language: lang };
}

/**
 * Claim one notice window, send at most once, and record sent / mock / unknown.
 * Used by the compliance worker and by tests with an in-memory store.
 */
export async function deliverNotice({ store, business, candidate, send }) {
  if (!business?.complianceProfile?.smsOptIn) {
    return { status: 'skipped' };
  }

  const query = { business_id: business.id, key: candidate.key };
  await store.updateOne(query, {
    $setOnInsert: {
      business_id: business.id,
      key: candidate.key,
      obligation: candidate.obligation,
      message: candidate.message,
      status: 'pending'
    }
  });

  const claimed = await store.findOneAndUpdate(
    { ...query, status: 'pending' },
    { $set: { status: 'sending' } }
  );
  if (!claimed) {
    return { status: 'already' };
  }

  try {
    const result = await send({ to: business.phone, message: candidate.message });
    const status = result?.mock ? 'mock' : 'sent';
    await store.updateOne(query, { $set: { status, message: candidate.message } });
    return { status };
  } catch {
    await store.updateOne(query, { $set: { status: 'unknown' } });
    return { status: 'unknown' };
  }
}
