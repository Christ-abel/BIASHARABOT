/**
 * Shared weekly-report assembly: one language, one set of labels, used by
 * the dashboard till slip and the SMS so they can never drift apart.
 *
 * Numbers are formatted here and never handed to Gemini. Labels come from
 * the fixed templates in report-labels.js, or — for a language we do not
 * ship yet — from a translator that must return the same keys. If that
 * translator throws or times out we log it and serve English.
 */

import { DEFAULT_REPORT_LANGUAGE, isSupportedReportLanguage, normalizeReportLanguage } from './languages.js';
import { REPORT_LABELS } from './report-labels.js';

export const TRANSLATION_TIMEOUT_MS = 4000;

export function formatKesAmount(value) {
  const amount = Number(value);
  const safe = Number.isFinite(amount) ? amount : 0;
  return `KSh ${safe.toFixed(2)}`;
}

export function withTimeout(promise, ms = TRANSLATION_TIMEOUT_MS) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Translation timed out')), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Only keep keys we already know, and only accept string values.
 * Stops a bad Gemini payload from inventing labels or smuggling numbers
 * into the till slip.
 */
export function mergeTranslatedLabels(english, translated) {
  const next = { ...english };
  if (!translated || typeof translated !== 'object') return next;
  for (const key of Object.keys(english)) {
    const value = translated[key];
    if (typeof value === 'string' && value.trim()) {
      next[key] = value.trim();
    }
  }
  return next;
}

/**
 * @param {string} language
 * @param {{ translate?: Function, timeoutMs?: number }} [options]
 *        `translate(englishLabels, language)` is injectable so tests can
 *        simulate a Gemini failure or hang without hitting the network.
 */
export async function resolveReportLabels(language, options = {}) {
  const { translate, timeoutMs = TRANSLATION_TIMEOUT_MS } = options;
  const requested = String(language || '').toLowerCase().trim();

  if (!requested || requested === DEFAULT_REPORT_LANGUAGE) {
    return { labels: { ...REPORT_LABELS.en }, language: DEFAULT_REPORT_LANGUAGE, fallback: false };
  }

  if (REPORT_LABELS[requested]) {
    return { labels: { ...REPORT_LABELS[requested] }, language: requested, fallback: false };
  }

  // Language we do not ship a template for: Gemini (or the injected
  // translator) may phrase the surrounding text. Numbers never go in.
  if (typeof translate === 'function') {
    try {
      const translated = await withTimeout(translate({ ...REPORT_LABELS.en }, requested), timeoutMs);
      return {
        labels: mergeTranslatedLabels(REPORT_LABELS.en, translated),
        language: requested,
        fallback: false
      };
    } catch (error) {
      console.error(
        `[REPORT LANGUAGE] Translation to "${requested}" failed, falling back to English:`,
        error?.message || error
      );
      return {
        labels: { ...REPORT_LABELS.en },
        language: DEFAULT_REPORT_LANGUAGE,
        fallback: true,
        fallbackReason: error?.message || 'Translation failed'
      };
    }
  }

  console.error(`[REPORT LANGUAGE] No template or translator for "${requested}", falling back to English`);
  return {
    labels: { ...REPORT_LABELS.en },
    language: DEFAULT_REPORT_LANGUAGE,
    fallback: true,
    fallbackReason: 'Unsupported language'
  };
}

export function formatItemProfitLines(report, labels, limit = 4) {
  if (!report || typeof report.gross_profit !== 'number') return '';

  const marginBit = Number.isFinite(report.gross_margin)
    ? ` (${report.gross_margin.toFixed(0)}%)`
    : '';

  const lines = [`${labels.grossProfit}: ${formatKesAmount(report.gross_profit)}${marginBit}`];

  const rows = report.item_profits || [];
  for (const row of rows.slice(0, limit)) {
    const soldBit = Number.isFinite(Number(row.unit_price))
      ? `${labels.soldAt || 'sold at'} ${formatKesAmount(row.unit_price)}`
      : Number.isFinite(Number(row.revenue))
        ? `${labels.rev || 'rev'} ${formatKesAmount(row.revenue)}`
        : '';
    if (row.cost_unknown) {
      lines.push(`  ${row.item}${soldBit ? `: ${soldBit}` : ''}`);
      continue;
    }
    const rowMargin = Number.isFinite(row.margin) ? ` (${row.margin.toFixed(0)}%)` : '';
    const prefix = soldBit ? `${soldBit} · ` : '';
    lines.push(`  ${row.item}: ${prefix}${formatKesAmount(row.gross_profit)}${rowMargin}`);
  }

  if (report.items_missing_cost > 0) {
    lines.push(`  ${String(labels.itemsMissingCost).replace('{count}', String(report.items_missing_cost))}`);
  }

  return lines.join('\n');
}

export function formatSoldItemLines(report, labels, limit = 8) {
  const rows = Array.isArray(report?.sold_items) ? report.sold_items : [];
  if (!rows.length) return '';
  const copy = labels || REPORT_LABELS.en;
  const lines = [copy.productsSold];
  for (const row of rows.slice(0, limit)) {
    lines.push(
      `  ${row.item}  ${row.qty} x ${formatKesAmount(row.unit_price)} = ${formatKesAmount(row.total)}`
    );
  }
  return lines.join('\n');
}

/**
 * SMS / plain-text till slip. Amounts are always `KSh 0.00` so a language
 * change cannot move a decimal or rename the currency.
 */
export function buildReportMessage({
  labels,
  title,
  businessName,
  shopPhone,
  tillNumber,
  periodLabel,
  soldLines,
  revenue,
  cost_of_goods,
  other_expenses,
  mpesa_fees,
  net_profit,
  outstanding_credit,
  itemProfitLines
}) {
  const copy = labels || REPORT_LABELS.en;
  const header = [
    title || copy.weeklyTitle,
    `${copy.shop}: ${businessName}`
  ];
  if (tillNumber) header.push(`${copy.till}: ${tillNumber}`);
  if (shopPhone) header.push(`${copy.phone}: ${shopPhone}`);
  if (periodLabel) header.push(`${copy.period}: ${periodLabel}`);
  const soldBlock = soldLines ? `${soldLines}\n` : '';
  const profitBlock = itemProfitLines ? `${itemProfitLines}\n` : '';
  return `${header.join('\n')}\n` +
    `---------------------\n` +
    soldBlock +
    `${copy.revenue}: ${formatKesAmount(revenue)}\n` +
    `${copy.costOfGoods}: ${formatKesAmount(cost_of_goods)}\n` +
    `${copy.otherExpenses}: ${formatKesAmount(other_expenses)}\n` +
    `${copy.mpesaFees}: ${formatKesAmount(mpesa_fees)}\n` +
    `---------------------\n` +
    `${copy.netProfit}: ${formatKesAmount(net_profit)}\n` +
    profitBlock +
    `${copy.outstandingCredit}: ${formatKesAmount(outstanding_credit)}\n` +
    `---------------------\n` +
    `${copy.poweredBy}`;
}

export async function assembleLocalizedReport({
  report,
  businessName,
  shopPhone,
  tillNumber,
  periodLabel,
  language,
  title,
  translate,
  timeoutMs
}) {
  const resolved = await resolveReportLabels(language, { translate, timeoutMs });
  const itemProfitLines = formatItemProfitLines(report, resolved.labels);
  const soldLines = formatSoldItemLines(report, resolved.labels);
  const sms = buildReportMessage({
    labels: resolved.labels,
    title: title || resolved.labels.weeklyTitle,
    businessName,
    shopPhone,
    tillNumber,
    periodLabel,
    soldLines,
    ...report,
    itemProfitLines
  });

  return {
    report,
    labels: resolved.labels,
    language: resolved.language,
    languageFallback: resolved.fallback,
    fallbackReason: resolved.fallbackReason || null,
    sms
  };
}

export { normalizeReportLanguage, isSupportedReportLanguage, DEFAULT_REPORT_LANGUAGE };
