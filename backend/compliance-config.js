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

/**
 * Shape used by compliance.js (assessCompliance / noticeCandidates).
 * Numbers stay aligned with COMPLIANCE_CONFIG above.
 */
export const rules = {
  version: COMPLIANCE_CONFIG.version,
  reviewedOn: '2025-review',
  reminderDays: COMPLIANCE_CONFIG.reminderWindowDays,
  tot: {
    minimumExclusive: COMPLIANCE_CONFIG.tot.minTurnover,
    maximumInclusive: COMPLIANCE_CONFIG.tot.maxTurnover,
    dueDay: COMPLIANCE_CONFIG.tot.dueDayOfMonth
  },
  vat: {
    minimumInclusive: COMPLIANCE_CONFIG.vat.registrationThreshold,
    dueDay: 20
  },
  annual: {
    companyMonthsAfterYearEnd: 6,
    individualMonth: COMPLIANCE_CONFIG.incomeTaxReturn.dueMonth,
    individualChanges: [{ effective: '2027-01-01', month: 4 }]
  },
  sources: {
    pin: 'https://itax.kra.go.ke',
    tot: 'https://www.kra.go.ke',
    vat: 'https://www.kra.go.ke',
    etims: 'https://www.kra.go.ke',
    permit: null,
    annual: 'https://itax.kra.go.ke'
  },
  counties: Object.fromEntries(KENYA_COUNTIES.map((name) => [name, { source: null }])),
  text: {
    en: {
      pin: ['KRA PIN registration', 'Every business needs a KRA PIN to file tax.'],
      tot: ['Turnover Tax (TOT)', 'TOT applies when yearly turnover is above KSh {totMin} and not more than KSh {totMax}. Filed monthly by the {totDay}th.'],
      vat: ['VAT registration', 'Register for VAT once taxable supplies reach KSh {vatMin} in 12 months. Due by the {vatDay}th if registered.'],
      etims: ['eTIMS electronic invoicing', 'KRA requires electronic tax invoices, especially once VAT applies.'],
      permit: ['County single business permit', 'Renew your county single business permit each year. Confirm the date with the county.'],
      annual: ['Annual income tax return', 'File the previous year of income on iTax by the deadline for your business type.'],
      statuses: {
        registered: 'Registered',
        action: 'Action needed',
        unknown: 'Needs details',
        not_applicable: 'Does not apply',
        review: 'Review'
      },
      reminder: 'Deadline approaching',
      threshold: 'Threshold crossed',
      notice: 'This is a reminder from BiasharaBot, not tax advice.'
    },
    sw: {
      pin: ['PIN ya KRA', 'Kila biashara inahitaji PIN ya KRA kuwasilisha kodi.'],
      tot: ['Kodi ya Mauzo (TOT)', 'TOT inahusu mauzo ya mwaka yakiwa juu ya KSh {totMin} na yasiyozidi KSh {totMax}. Inawasilishwa kila mwezi kufikia tarehe {totDay}.'],
      vat: ['Usajili wa VAT', 'Jisajili kwa VAT mauzo yanapofika KSh {vatMin} katika miezi 12. Tarehe ni {vatDay} ukiwa umesajiliwa.'],
      etims: ['Ankara za kielektroniki eTIMS', 'KRA inahitaji ankara za kielektroniki, hasa VAT inapohusu.'],
      permit: ['Leseni moja ya biashara ya kaunti', 'Fanya upya leseni ya kaunti kila mwaka. Thibitisha tarehe ofisini.'],
      annual: ['Marejesho ya kodi ya mwaka', 'Wasilisha mwaka uliopita wa mapato kwenye iTax kufikia tarehe ya biashara yako.'],
      statuses: {
        registered: 'Imesajiliwa',
        action: 'Inahitaji hatua',
        unknown: 'Inahitaji maelezo',
        not_applicable: 'Haihusu',
        review: 'Kagua'
      },
      reminder: 'Tarehe inakaribia',
      threshold: 'Kizingiti kimevukwa',
      notice: 'Hii ni ukumbusho kutoka BiasharaBot, si ushauri wa kodi.'
    }
  }
};
