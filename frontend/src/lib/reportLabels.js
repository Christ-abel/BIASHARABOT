/**
 * English report labels, mirroring backend/report.js. The API returns the
 * labels for the owner's chosen language with every report; these are what
 * the till slip shows until that arrives, and what fills any gap in an older
 * cached snapshot that pre-dates translated reports.
 */
export const DEFAULT_REPORT_LABELS = Object.freeze({
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
  footer: 'Powered by BiasharaGPT!',
});

/** Shown in the selector until GET /api/reports/languages answers. */
export const DEFAULT_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'sw', name: 'Kiswahili' },
];

export const DEFAULT_LANGUAGE = 'en';
