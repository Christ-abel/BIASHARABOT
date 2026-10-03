/**
 * Weekly / daily report: figures, labels and the fixed message template.
 *
 * Figures are computed here from ledger entries and formatted locally. Labels
 * are the only part of a report that changes with the owner's language, and
 * they are substituted into the template *after* translation, so a translated
 * report always carries exactly the same KSh amounts as the English one.
 */

// Codes follow ISO 639-1. Add a language here (and a mock dictionary in
// translate.js for local development) to make it selectable everywhere.
export const SUPPORTED_LANGUAGES = {
  en: 'English',
  sw: 'Kiswahili'
};

export const DEFAULT_LANGUAGE = 'en';

export const isSupportedLanguage = (code) =>
  typeof code === 'string' && Object.prototype.hasOwnProperty.call(SUPPORTED_LANGUAGES, code);

// Every string a report needs. Only these values are ever translated; keys,
// numbers, currency and the business name are not.
export const REPORT_LABELS_EN = Object.freeze({
  title_weekly: 'BiasharaGPT Weekly Report',
  title_daily: 'BiasharaGPT Daily Report',
  shop: 'Shop',
  revenue: 'Revenue',
  cost_of_goods: 'Cost of Goods',
  other_expenses: 'Other Expenses',
  mpesa_fees: 'M-Pesa Fees',
  net_profit: 'Net Profit',
  outstanding_credit: 'Outstanding Credit',
  printed_at: 'Printed at',
  footer: 'Powered by BiasharaGPT!'
});

export const REPORT_LABEL_KEYS = Object.freeze(Object.keys(REPORT_LABELS_EN));

/** Amounts are formatted the same way in every language: `KSh 1234.50`. */
export const formatAmount = (value) => `KSh ${(Number(value) || 0).toFixed(2)}`;

/**
 * Sums ledger entries into the report figures.
 *
 * Every total is coerced to a number with a 0 fallback: a single entry with a
 * missing total previously turned these sums into NaN, which JSON.stringify
 * silently converts to null and crashed the frontend's .toFixed() calls.
 */
export function computeReportFigures(entries) {
  const sum = (rows) => rows.reduce((acc, e) => acc + (Number(e.total) || 0), 0);

  const revenue = sum(entries.filter((e) => e.type === 'sale'));
  const cost_of_goods = sum(entries.filter((e) => e.type === 'purchase'));
  const other_expenses = sum(entries.filter((e) => e.type === 'expense' && e.source !== 'payhero'));
  const mpesa_fees = sum(entries.filter((e) => e.type === 'expense' && e.source === 'payhero'));
  const outstanding_credit = sum(entries.filter((e) => e.type === 'credit' && !e.matched));
  const net_profit = revenue - cost_of_goods - other_expenses - mpesa_fees;

  return { revenue, cost_of_goods, other_expenses, mpesa_fees, net_profit, outstanding_credit };
}

/**
 * Fixed SMS/report template. `labels` defaults to English; pass the result of
 * getReportLabels() for a translated report. `title` is a label key
 * ('title_weekly' or 'title_daily').
 */
export function buildReportMessage({
  title = 'title_weekly',
  businessName,
  labels = REPORT_LABELS_EN,
  revenue,
  cost_of_goods,
  other_expenses,
  mpesa_fees,
  net_profit,
  outstanding_credit
}) {
  const l = { ...REPORT_LABELS_EN, ...labels };
  return `${l[title] || l.title_weekly}\n` +
    `${l.shop}: ${businessName}\n` +
    `---------------------\n` +
    `${l.revenue}: ${formatAmount(revenue)}\n` +
    `${l.cost_of_goods}: ${formatAmount(cost_of_goods)}\n` +
    `${l.other_expenses}: ${formatAmount(other_expenses)}\n` +
    `${l.mpesa_fees}: ${formatAmount(mpesa_fees)}\n` +
    `---------------------\n` +
    `${l.net_profit}: ${formatAmount(net_profit)}\n` +
    `${l.outstanding_credit}: ${formatAmount(outstanding_credit)}\n` +
    `---------------------\n` +
    `${l.footer}`;
}
