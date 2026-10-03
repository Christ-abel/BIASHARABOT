import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const attempts = new Map();

/** Dummy hash so a missing account still spends a bcrypt compare. */
const DUMMY_HASH = bcrypt.hashSync('biashara-dummy-password', 10);

export function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits || String(raw || '').trim();
}

export function looksLikeEmail(raw) {
  const value = String(raw || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || /^[^\s@]+@localhost$/i.test(value);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (password.length > 200) {
    throw new Error('Password is too long');
  }
}

export function rateLimit(key, { max = 5, windowMs = 15 * 60_000 } = {}) {
  const now = Date.now();
  for (const [entryKey, row] of attempts) {
    if (row.until <= now) attempts.delete(entryKey);
  }
  const row = attempts.get(key) || { count: 0, until: now + windowMs };
  if (row.count >= max) return false;
  row.count += 1;
  attempts.set(key, row);
  return true;
}

export function issueSession(businessId) {
  const token = randomBytes(32).toString('hex');
  sessions.set(hashToken(token), {
    businessId,
    expires: Date.now() + SESSION_MS
  });
  return token;
}

export function revokeSession(header) {
  const token = bearerToken(header);
  if (token) sessions.delete(hashToken(token));
}

export function readSession(header) {
  const token = bearerToken(header);
  if (!token) return null;
  const session = sessions.get(hashToken(token));
  if (!session || session.expires <= Date.now()) return null;
  return session;
}

export function requireOwnBusiness(req, res, next) {
  const session = readSession(req.headers.authorization);
  if (!session || session.businessId !== req.params.id) {
    return res.status(401).json({ error: 'Please log in again to change this shop' });
  }
  next();
}

export async function verifyBusinessPassword(business, password) {
  const hash = business?.password || DUMMY_HASH;
  return bcrypt.compare(typeof password === 'string' ? password : '', hash);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function bearerToken(header) {
  const value = String(header || '');
  return value.replace(/^Bearer\s+/i, '').trim();
}
