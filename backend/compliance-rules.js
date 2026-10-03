/**
 * Map a shop profile + ledger turnover onto KRA / county obligations.
 *
 * Dates and thresholds come from compliance-config.js. Gemini is not
 * consulted here — it must never invent a deadline or a band.
 */

import { COMPLIANCE_CONFIG } from './compliance-config.js';
import { isComplianceProfileIncomplete } from './business-public.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function trailingTurnover(entries = [], days = 365, asOf = new Date()) {
  const since = new Date(asOf.getTime() - days * MS_PER_DAY);
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry.type === 'sale' && entry.timestamp && new Date(entry.timestamp) >= since)
    .reduce((sum, entry) => sum + (Number(entry.total) || 0), 0);
}

export function resolveTurnover({ entries, estimatedAnnualTurnover, asOf }) {
  const ledger12m = trailingTurnover(entries, 365, asOf);
  const estimated = Number(estimatedAnnualTurnover) || 0;
  return {
    ledger12m,
    estimated,
    used: Math.max(ledger12m, estimated)
  };
}

function atLocalNoon(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/** Next occurrence of month/day on or after asOf (or the one just passed if still this cycle). */
export function nextAnnualDeadline(asOf, month, day) {
  const year = asOf.getFullYear();
  let deadline = atLocalNoon(year, month, day);
  if (deadline < asOf) {
    deadline = atLocalNoon(year + 1, month, day);
  }
  return deadline;
}

/** TOT is monthly; due on dueDayOfMonth of the month after the tax month. */
export function nextMonthlyDeadline(asOf, dueDay) {
  const year = asOf.getFullYear();
  const month = asOf.getMonth();
  const thisMonth = new Date(year, month, dueDay, 12, 0, 0, 0);
  if (thisMonth >= asOf) return thisMonth;
  return new Date(year, month + 1, dueDay, 12, 0, 0, 0);
}

export function daysUntil(deadline, asOf) {
  if (!deadline) return null;
  return Math.ceil((deadline.getTime() - asOf.getTime()) / MS_PER_DAY);
}

function deadlineStatus(deadline, asOf, reminderDays) {
  if (!deadline) return 'ok';
  const days = daysUntil(deadline, asOf);
  if (days < 0) return 'overdue';
  if (days <= reminderDays) return 'upcoming';
  return 'ok';
}

export function windowKeyForDeadline(obligationId, deadline) {
  if (!deadline) return `${obligationId}:open`;
  const y = deadline.getFullYear();
  const m = String(deadline.getMonth() + 1).padStart(2, '0');
  const d = String(deadline.getDate()).padStart(2, '0');
  return `${obligationId}:${y}-${m}-${d}`;
}

/**
 * @returns {{
 *   turnover: object,
 *   profileIncomplete: boolean,
 *   obligations: object[],
 *   triggers: object[]
 * }}
 */
export function evaluateCompliance({
  profile = {},
  entries = [],
  asOf = new Date(),
  config = COMPLIANCE_CONFIG
} = {}) {
  const when = asOf instanceof Date ? asOf : new Date(asOf);
  const turnover = resolveTurnover({
    entries,
    estimatedAnnualTurnover: profile.estimatedAnnualTurnover,
    asOf: when
  });
  const used = turnover.used;
  const reminderDays = config.reminderWindowDays;
  const profileIncomplete = isComplianceProfileIncomplete(profile);

  const totDeadline = nextMonthlyDeadline(when, config.tot.dueDayOfMonth);
  const vatApplies = used >= config.vat.registrationThreshold;
  const totApplies = used > config.tot.minTurnover && used <= config.tot.maxTurnover;
  // Above the TOT ceiling the shop is in the ordinary income-tax / VAT world,
  // not TOT — still flag VAT if the VAT threshold is crossed.
  const needsKraPin = profile.kraPin !== 'yes';
  const etimsApplies = vatApplies || needsKraPin || config.etims.requiredWhenVatApplies;

  const incomeDeadline = nextAnnualDeadline(when, config.incomeTaxReturn.dueMonth, config.incomeTaxReturn.dueDay);
  const permitDeadline = nextAnnualDeadline(when, config.countyPermit.renewalMonth, config.countyPermit.renewalDay);

  const obligations = [
    {
      id: 'kra_pin',
      applies: true,
      status: needsKraPin ? 'action_needed' : 'ok',
      deadline: null,
      windowKey: needsKraPin ? 'kra_pin:register' : 'kra_pin:held',
      titleKey: 'kraPinTitle',
      bodyKey: 'kraPinBody',
      vars: {},
      noticeType: needsKraPin ? 'new_obligation' : null
    },
    {
      id: 'tot',
      applies: totApplies,
      status: totApplies ? deadlineStatus(totDeadline, when, reminderDays) : 'ok',
      deadline: totApplies ? totDeadline : null,
      windowKey: totApplies ? windowKeyForDeadline('tot', totDeadline) : 'tot:na',
      titleKey: 'totTitle',
      bodyKey: 'totBody',
      vars: {
        min: config.tot.minTurnover,
        max: config.tot.maxTurnover,
        rate: config.tot.ratePercent,
        deadline: totDeadline
      },
      // Threshold SMS covers "you entered the TOT band". This row only
      // reminds when the monthly filing date is close.
      noticeType: totApplies ? 'deadline_approaching' : null
    },
    {
      id: 'vat',
      applies: vatApplies,
      status: vatApplies ? 'action_needed' : 'ok',
      deadline: null,
      windowKey: vatApplies ? 'vat:threshold' : 'vat:below',
      titleKey: 'vatTitle',
      bodyKey: 'vatBody',
      vars: { threshold: config.vat.registrationThreshold },
      noticeType: null
    },
    {
      id: 'etims',
      applies: Boolean(etimsApplies),
      status: etimsApplies ? 'action_needed' : 'ok',
      deadline: null,
      windowKey: etimsApplies ? 'etims:enrol' : 'etims:na',
      titleKey: 'etimsTitle',
      bodyKey: 'etimsBody',
      vars: {},
      noticeType: etimsApplies ? 'new_obligation' : null
    },
    {
      id: 'county_permit',
      applies: true,
      status: profile.county ? deadlineStatus(permitDeadline, when, reminderDays) : 'action_needed',
      deadline: profile.county ? permitDeadline : null,
      windowKey: profile.county ? windowKeyForDeadline('county_permit', permitDeadline) : 'county_permit:choose',
      titleKey: 'permitTitle',
      bodyKey: profile.county ? 'permitBody' : 'permitBodyNoCounty',
      vars: { county: profile.county || '', deadline: permitDeadline },
      noticeType: profile.county ? 'deadline_approaching' : 'new_obligation'
    },
    {
      id: 'income_tax_return',
      applies: true,
      status: deadlineStatus(incomeDeadline, when, reminderDays),
      deadline: incomeDeadline,
      windowKey: windowKeyForDeadline('income_tax_return', incomeDeadline),
      titleKey: 'incomeTaxTitle',
      bodyKey: 'incomeTaxBody',
      vars: { deadline: incomeDeadline },
      noticeType: 'deadline_approaching'
    }
  ];

  const triggers = [];
  if (totApplies) {
    triggers.push({
      id: 'threshold_tot',
      crossed: true,
      windowKey: 'threshold:tot',
      titleKey: 'thresholdTot',
      vars: { min: config.tot.minTurnover }
    });
  }
  if (vatApplies) {
    triggers.push({
      id: 'threshold_vat',
      crossed: true,
      windowKey: 'threshold:vat',
      titleKey: 'thresholdVat',
      vars: { threshold: config.vat.registrationThreshold }
    });
  }

  // Only remind on approaching / overdue deadlines, or on a newly
  // triggered obligation. Quiet "on track" rows must not SMS.
  for (const row of obligations) {
    if (!row.applies || !row.noticeType) continue;
    if (row.noticeType === 'deadline_approaching' && row.status === 'ok') {
      row.noticeType = null;
    }
  }

  return {
    turnover,
    profileIncomplete,
    configVersion: config.version,
    obligations,
    triggers
  };
}

/** Pure no-repeat check — used by tests without Mongo. */
export function shouldSendNotice(alreadySentKeys, windowKey) {
  if (!windowKey) return false;
  return !alreadySentKeys.has(windowKey);
}
