/**
 * Sends this week's till-slip SMS to every shop, then exits.
 *
 *   npm run job:weekly-reports
 *
 * Meant for a Render Cron Job (or any crontab) scheduled for Sunday evening
 * Kenyan time, e.g. `0 17 * * 0` (17:00 UTC = 20:00 EAT), so the seven-day
 * window covers Monday to Sunday. Re-running it the same week is safe: shops
 * that already got their SMS are skipped.
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { runWeeklyReportJob } from '../report-delivery.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const uri = process.env.MONGODB_URI?.trim();
if (!uri) {
  console.error('[WEEKLY JOB] MONGODB_URI is not set');
  process.exit(1);
}

try {
  await mongoose.connect(uri);
  const summary = await runWeeklyReportJob();
  process.exitCode = summary.errors > 0 ? 1 : 0;
} catch (error) {
  console.error('[WEEKLY JOB] Run failed:', error?.message || error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
