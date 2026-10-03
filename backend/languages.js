/**
 * Per-owner report languages.
 *
 * Add a row here when a new language ships — Business.reportLanguage,
 * the settings selector, and resolveReportLabels() all read this list.
 * Unknown or missing values always become English so old owner records
 * need no migration.
 */

export const DEFAULT_REPORT_LANGUAGE = 'en';

export const REPORT_LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili' }
];

const KNOWN = new Set(REPORT_LANGUAGES.map((row) => row.code));

export function normalizeReportLanguage(value) {
  const code = String(value || '').toLowerCase().trim();
  return KNOWN.has(code) ? code : DEFAULT_REPORT_LANGUAGE;
}

export function isSupportedReportLanguage(value) {
  return KNOWN.has(String(value || '').toLowerCase().trim());
}
