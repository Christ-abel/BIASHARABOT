import express from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'node:crypto';
import Business from './models/Business.js';
import Entry from './models/Entry.js';
import Notice from './models/ComplianceNotice.js';
import { assessCompliance, validateProfile, noticeCandidates, kenyaDate, profileDefaults } from './compliance.js';
import { deliverNotice } from './compliance-notices.js';
import { sendSMS } from './sms.js';

export const complianceRouter = express.Router();
const sessions = new Map();
const attempts = new Map();
const tokenHash = token => createHash('sha256').update(token).digest('hex');
complianceRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
complianceRouter.post('/unlock', async (req, res) => {
  try {
    const { businessId, password } = req.body;
    if (typeof businessId !== 'string' || typeof password !== 'string' || password.length > 200) return res.status(400).json({ error: 'Business ID and password required' });
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
    for (const [key, attempt] of attempts) if (attempt.until <= now) attempts.delete(key);
    const key = `${req.ip}:${businessId}`;
    const attempt = attempts.get(key) || { count: 0, until: now + 15 * 60_000 };
    if (attempt.count >= 5) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    attempt.count++;
    attempts.set(key, attempt);
    const business = await Business.findOne({ id: businessId });
    if (!business || !await bcrypt.compare(password, business.password)) return res.status(401).json({ error: 'Invalid business or password' });
    attempts.delete(key);
    const token = randomBytes(32).toString('hex');
    sessions.set(tokenHash(token), { businessId: business.id, expires: now + 60 * 60_000 });
    res.json({ token });
  } catch { res.status(500).json({ error: 'Could not unlock compliance' }); }
});
complianceRouter.use(async (req, res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
  const session = sessions.get(tokenHash(token));
  if (!session || session.expires <= Date.now()) return res.status(401).json({ error: 'Unlock compliance with your admin password' });
  try {
    req.complianceBusiness = await Business.findOne({ id: session.businessId });
    if (!req.complianceBusiness) return res.status(404).json({ error: 'Business not found' });
    next();
  } catch { res.status(500).json({ error: 'Could not load business' }); }
});
complianceRouter.post('/lock', (req, res) => {
  sessions.delete(tokenHash(req.headers.authorization?.replace(/^Bearer /, '') || ''));
  res.json({ success: true });
});
export async function businessAssessment(business, now = new Date()) {
  const today = kenyaDate(now);
  const year = Number(today.slice(0, 4));
  const calendarStart = new Date(`${year}-01-01T00:00:00+03:00`);
  const trailingStart = new Date(now);
  trailingStart.setUTCFullYear(trailingStart.getUTCFullYear() - 1);
  const entries = await Entry.find({ business_id: business.id, type: 'sale', timestamp: { $gte: new Date(Math.min(calendarStart, trailingStart)), $lte: now } }).select('total timestamp').lean();
  const sum = start => entries.filter(e => e.timestamp >= start).reduce((s, e) => s + Math.max(0, Number(e.total) || 0), 0);
  return assessCompliance(business.complianceProfile?.toObject?.() || business.complianceProfile || {}, {
    calendarYear: year, calendarYearRevenue: sum(calendarStart), trailing12MonthRevenue: sum(trailingStart),
    calendarStart: calendarStart.toISOString(), trailingStart: trailingStart.toISOString(), end: now.toISOString(),
  }, now);
}
complianceRouter.get('/', async (req, res) => {
  try {
    const assessment = await businessAssessment(req.complianceBusiness);
    const history = await Notice.find({ business_id: req.complianceBusiness.id }).sort({ createdAt: -1 }).limit(30).lean();
    res.json({ ...assessment, notices: noticeCandidates(assessment), history });
  } catch { res.status(500).json({ error: 'Could not load compliance guidance' }); }
});
complianceRouter.put('/profile', async (req, res) => {
  let profile;
  try { profile = validateProfile(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
  try {
    const business = req.complianceBusiness;
    business.complianceProfile = { ...profileDefaults, ...business.complianceProfile?.toObject(), ...profile };
    await business.save();
    await processBusinessNotices(business);
    res.json(await businessAssessment(business));
  } catch { res.status(500).json({ error: 'Could not save compliance profile' }); }
});
export async function processBusinessNotices(business) {
  try {
    await Notice.init();
    const assessment = await businessAssessment(business);
    for (const candidate of noticeCandidates(assessment)) await deliverNotice({ store: Notice, business, candidate, send: sendSMS });
  } catch (error) { console.error('Compliance notice processing failed:', error.message); }
}
export function startComplianceWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Ensure uniqueness exists before any reminders are claimed.
      await Notice.init();
      for await (const business of Business.find({ 'complianceProfile.smsOptIn': true }).cursor()) await processBusinessNotices(business);
    } catch (error) { console.error('Compliance worker failed:', error.message); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(tick, 15 * 60_000);
  timer.unref();
  return timer;
}
