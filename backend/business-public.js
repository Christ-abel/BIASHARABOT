import { normalizeReportLanguage } from './languages.js';

/** Safe owner record for the dashboard and localStorage. Never includes password. */
export function toPublicBusiness(biz) {
  if (!biz) return null;
  return {
    id: biz.id,
    name: biz.name,
    phone: biz.phone,
    email: biz.email,
    tillNumber: biz.tillNumber,
    reportLanguage: normalizeReportLanguage(biz.reportLanguage),
    businessType: biz.businessType || 'sole_proprietor',
    county: biz.county || '',
    kraPin: biz.kraPin || 'unknown',
    estimatedAnnualTurnover: Number(biz.estimatedAnnualTurnover) || 0,
    created_at: biz.created_at
  };
}

export function isComplianceProfileIncomplete(biz) {
  if (!biz) return true;
  const county = String(biz.county || '').trim();
  const kraPin = biz.kraPin || 'unknown';
  return !county || kraPin === 'unknown';
}
