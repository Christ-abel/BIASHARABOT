/**
 * In-process SMS scheduler (node-cron), started by server.js.
 *
 * Two jobs, both in Kenya time:
 *   - weekly till slip   REPORT_SMS_CRON      default "0 20 * * 0" (Sunday 20:00)
 *   - credit reminders   CREDIT_REMINDER_CRON default "0 *\/6 * * *" (every 6 hours)
 * Set either to "off" to disable it, e.g. when a Render Cron Job or an
 * external pinger calls /api/jobs/weekly-reports instead.
 *
 * Demo mode, for showing the scheduled SMS live without texting every shop:
 *   SMS_DEMO_SHOP=<business id>   only this shop gets the till slip, even
 *                                 with no sales logged this week
 *   REPORT_SMS_CRON="*\/2 * * * *" fire every 2 minutes
 *   SMS_DEMO_REPEAT=1             send on every run instead of once a week
 *   SMS_DEMO_MAX_SENDS=3          stop repeating after this many SMS
 *                                 (protects the Tiara balance)
 *
 * The timer only fires while the process is awake. On a free Render service
 * that sleeps when idle, use the HTTP job endpoint from an external cron.
 */

import cron from 'node-cron';
import Business from './models/Business.js';
import { runWeeklyReportJob } from './report-delivery.js';
import { runCreditReminders } from './credit-reminders.js';

const TIMEZONE = 'Africa/Nairobi';
const DEFAULT_REPORT_CRON = '0 20 * * 0';
const DEFAULT_CREDIT_CRON = '0 */6 * * *';
const DEFAULT_DEMO_MAX_SENDS = 3;

/** Reads the scheduler settings from the environment. Exported for tests. */
export function readSchedulerConfig(env = process.env) {
  const pattern = (value, fallback) => {
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    if (raw.toLowerCase() === 'off') return null;
    return raw;
  };
  const demoShop = String(env.SMS_DEMO_SHOP || '').trim() || null;
  const maxSends = Number.parseInt(env.SMS_DEMO_MAX_SENDS, 10);
  return {
    reportCron: pattern(env.REPORT_SMS_CRON, DEFAULT_REPORT_CRON),
    creditCron: pattern(env.CREDIT_REMINDER_CRON, DEFAULT_CREDIT_CRON),
    demoShop,
    // Repeating is only allowed when it is fenced to a single demo shop.
    demoRepeat: Boolean(demoShop) && ['1', 'true', 'yes'].includes(String(env.SMS_DEMO_REPEAT || '').toLowerCase()),
    demoMaxSends: Number.isFinite(maxSends) && maxSends > 0 ? maxSends : DEFAULT_DEMO_MAX_SENDS
  };
}

/**
 * Builds the weekly-report tick for a config. In demo mode it targets one
 * shop, sends even with an empty week, and (with repeat) bypasses the
 * once-a-week rule until demoMaxSends SMS have gone out.
 */
export function createWeeklyReportTick(config, { runJob = runWeeklyReportJob, findShops } = {}) {
  let demoSent = 0;
  const listDemoShop = findShops || (() => Business.find({ id: config.demoShop }).cursor());

  return async function weeklyReportTick() {
    if (!config.demoShop) {
      return runJob();
    }

    if (config.demoRepeat && demoSent >= config.demoMaxSends) {
      console.log(`[SCHEDULER] Demo limit reached (${demoSent} SMS); not sending again. Restart the server to reset.`);
      return { skipped: 'demo_limit' };
    }

    const summary = await runJob({
      listBusinesses: listDemoShop,
      trigger: config.demoRepeat ? 'manual' : 'schedule',
      allowEmpty: true
    });
    demoSent += summary?.sent || 0;
    if (!summary?.sent && !summary?.skipped && !summary?.failed && !summary?.errors) {
      console.warn(`[SCHEDULER] Demo shop "${config.demoShop}" was not found; check SMS_DEMO_SHOP.`);
    }
    return summary;
  };
}

function scheduleJob(name, pattern, task) {
  if (!pattern) {
    console.log(`[SCHEDULER] ${name}: off`);
    return null;
  }
  if (!cron.validate(pattern)) {
    console.error(`[SCHEDULER] ${name}: invalid cron pattern "${pattern}", not scheduled`);
    return null;
  }
  const job = cron.schedule(pattern, async () => {
    console.log(`[SCHEDULER] ${name}: running`);
    try {
      const result = await task();
      console.log(`[SCHEDULER] ${name}: done`, JSON.stringify(result));
    } catch (error) {
      console.error(`[SCHEDULER] ${name}: failed`, error?.message || error);
    }
  }, { timezone: TIMEZONE, name, noOverlap: true });
  console.log(`[SCHEDULER] ${name}: "${pattern}" (${TIMEZONE}), next run ${job.getNextRun()?.toISOString?.() || 'unknown'}`);
  return job;
}

export function startSmsScheduler(env = process.env) {
  const config = readSchedulerConfig(env);

  if (config.demoShop) {
    console.log(
      `[SCHEDULER] DEMO MODE: till slip only for shop "${config.demoShop}"` +
      (config.demoRepeat ? `, every run, max ${config.demoMaxSends} SMS` : ', once this week')
    );
  }

  return {
    config,
    weeklyReport: scheduleJob('weekly till slip SMS', config.reportCron, createWeeklyReportTick(config)),
    creditReminders: scheduleJob('credit reminder SMS', config.creditCron, () => runCreditReminders())
  };
}
