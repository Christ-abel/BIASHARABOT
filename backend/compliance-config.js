/**
 * KRA and county thresholds in one place.
 *
 * Verify every number against the current Finance Act / KRA public
 * guidance before shipping a release — do not scatter these through
 * rules or UI copy. Update this file when the Act changes.
 *
 * Sources to re-check:
 *   - Turnover Tax band and rate (Finance Act; KRA TOT page)
 *   - VAT mandatory-registration threshold (VAT Act)
 *   - eTIMS enrolment rules (KRA eTIMS notices)
 *   - Income tax return due date (TPA / iTax calendar) — 30 June
 *   - County single business permit renewal (varies; 31 March is the
 *     common statutory window we track until a county is specified)
 */

export const COMPLIANCE_CONFIG = {
  version: '2025-review',
  currency: 'KES',
  tot: {
    minTurnover: 1_000_000,
    maxTurnover: 25_000_000,
    ratePercent: 3,
    filing: 'monthly',
    dueDayOfMonth: 20
  },
  vat: {
    registrationThreshold: 5_000_000
  },
  etims: {
    requiredWhenVatApplies: true,
    requiredWithoutKraPin: true
  },
  incomeTaxReturn: {
    dueMonth: 6,
    dueDay: 30
  },
  countyPermit: {
    renewalMonth: 3,
    renewalDay: 31
  },
  reminderWindowDays: 14
};

export const KENYA_COUNTIES = [
  'Baringo', 'Bomet', 'Bungoma', 'Busia', 'Elgeyo-Marakwet', 'Embu',
  'Garissa', 'Homa Bay', 'Isiolo', 'Kajiado', 'Kakamega', 'Kericho',
  'Kiambu', 'Kilifi', 'Kirinyaga', 'Kisii', 'Kisumu', 'Kitui',
  'Kwale', 'Laikipia', 'Lamu', 'Machakos', 'Makueni', 'Mandera',
  'Marsabit', 'Meru', 'Migori', 'Mombasa', 'Murang\'a', 'Nairobi',
  'Nakuru', 'Nandi', 'Narok', 'Nyamira', 'Nyandarua', 'Nyeri',
  'Samburu', 'Siaya', 'Taita-Taveta', 'Tana River', 'Tharaka-Nithi',
  'Trans Nzoia', 'Turkana', 'Uasin Gishu', 'Vihiga', 'Wajir', 'West Pokot'
];

export function formatConfigAmount(value) {
  return Number(value).toLocaleString('en-KE');
}
