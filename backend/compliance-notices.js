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
    return interpolate(labels.newObligationSms, {
      title: phraseCompliance(labels, trigger.titleKey, trigger.vars),
      shop: shopName,
      hint: phraseCompliance(labels, trigger.titleKey, trigger.vars)
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
 * Send at most one SMS per obligation per window. The unique index is the
 * last line of defence if two requests race.
 */
export async function dispatchComplianceNotices({
  business,
  evaluation,
  language,
  send = sendSMS
}) {
  const lang = normalizeReportLanguage(language || business.reportLanguage);
  const labels = COMPLIANCE_LABELS[lang] || COMPLIANCE_LABELS.en;
  const shopName = business.name || 'Duka';
  const sent = [];
  const skipped = [];

  for (const item of collectOutbound(evaluation)) {
    const existing = await ComplianceNotice.findOne({
      business_id: business.id,
      obligation_id: item.obligation_id,
      notice_type: item.notice_type,
      window_key: item.window_key
    });

    if (existing) {
      skipped.push({ ...item, reason: 'already_sent' });
      continue;
    }

    const message = buildNoticeMessage({
      labels,
      shopName,
      obligation: item.obligation,
      trigger: item.trigger
    }).slice(0, 480);

    const sms = await send({ to: business.phone, message });

    try {
      const record = await ComplianceNotice.create({
        business_id: business.id,
        obligation_id: item.obligation_id,
        notice_type: item.notice_type,
        window_key: item.window_key,
        language: lang,
        message
      });
      sent.push({ ...item, message, sms, id: record._id });
    } catch (error) {
      if (error.code === 11000) {
        skipped.push({ ...item, reason: 'already_sent' });
        continue;
      }
      throw error;
    }
  }

  return { sent, skipped, language: lang };
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
