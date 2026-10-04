/**
 * The single SMS channel for the app: every outbound SMS (weekly reports,
 * compliance notices, alerts) goes through sendSMS() here, via Tiara Connect.
 *
 * Configuration (environment):
 *   TIARA_API_KEY    bearer token. 'mock' logs instead of sending. Empty is an
 *                    error, never a silent mock, so a misconfigured deploy
 *                    cannot report "SMS sent" while sending nothing.
 *   TIARA_BASE_URL   defaults to https://api2.tiaraconnect.io/api/messaging
 *   TIARA_SENDER_ID  defaults to CONNECT
 *
 * The request mirrors the flow known to deliver on this account: a JSON body
 * of exactly { to, message, from } and a bearer header. Tiara answers HTTP 200
 * even when it rejects a message, so success is read from its own status
 * fields, not from the HTTP code.
 *
 * Cost control: the text is folded into the GSM-7 alphabet before sending,
 * because a single "–" or "·" switches the whole message to UCS-2 and
 * roughly doubles the billed parts, and anything over MAX_SMS_PARTS is
 * refused rather than sent.
 */

export const DEFAULT_BASE_URL = 'https://api2.tiaraconnect.io/api/messaging';
export const DEFAULT_SENDER_ID = 'CONNECT';
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_SMS_PARTS = 6;

// GSM 03.38 basic set (1 unit each) and extension set (2 units each).
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
);
const GSM_EXTENDED = new Set('^{}\\[~]|€');

// Characters that sneak in from labels, date ranges and phone keyboards,
// mapped to their closest GSM-7 equivalent.
const GSM_REPLACEMENTS = {
  '–': '-', '—': '-', '‒': '-', '−': '-',
  '·': '-', '•': '-',
  '‘': "'", '’': "'", '‚': "'", '`': "'",
  '“': '"', '”': '"', '„': '"',
  '…': '...', '≈': '~', '×': 'x',
  ' ': ' ', ' ': ' ', ' ': ' ', '\t': ' '
};

/** Folds text into GSM-7 so the message is billed at 153/160 chars per part. */
export function toGsmText(message) {
  let out = '';
  for (const char of String(message ?? '').normalize('NFC')) {
    if (GSM_BASIC.has(char) || GSM_EXTENDED.has(char)) {
      out += char;
    } else if (GSM_REPLACEMENTS[char] !== undefined) {
      out += GSM_REPLACEMENTS[char];
    } else {
      // Accented letters lose the accent (é is GSM, ê is not); anything with
      // no Latin base (emoji, symbols) is dropped.
      const base = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if ([...base].every((c) => GSM_BASIC.has(c))) out += base;
    }
  }
  return out.replace(/[ ]{2,}/g, ' ').trim();
}

/** Billed parts for a GSM-7 message (extension characters cost two units). */
export function countSmsParts(gsmText) {
  let units = 0;
  for (const char of String(gsmText)) units += GSM_EXTENDED.has(char) ? 2 : 1;
  if (units === 0) return 0;
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

/** 254712345678 → 2547****678, for logs. */
export function maskPhone(msisdn) {
  const value = String(msisdn || '');
  if (value.length < 7) return '***';
  return `${value.slice(0, 4)}****${value.slice(-3)}`;
}

export function getSmsConfig(env = process.env) {
  const apiKey = (env.TIARA_API_KEY || '').trim();
  return {
    apiKey,
    mock: apiKey === 'mock',
    baseUrl: (env.TIARA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    senderId: (env.TIARA_SENDER_ID || DEFAULT_SENDER_ID).trim()
  };
}

/**
 * Normalises a Kenyan mobile number to 2547XXXXXXXX / 2541XXXXXXXX.
 * Returns null when the input cannot be one (landlines, foreign numbers,
 * typos), so we never pay to text a number that cannot receive it.
 */
export function formatPhoneNumber(phone) {
  const cleaned = String(phone || '').replace(/\D/g, '');
  if (!cleaned) return null;
  let local = null;
  if (cleaned.startsWith('254') && cleaned.length === 12) local = cleaned.slice(3);
  else if (cleaned.startsWith('0') && cleaned.length === 10) local = cleaned.slice(1);
  else if (cleaned.length === 9) local = cleaned;
  return local && /^[17]\d{8}$/.test(local) ? `254${local}` : null;
}

/**
 * Tiara's verdict on a message. It returns statusCode "0" / status "SUCCESS"
 * when the message was accepted and e.g. "408" / "FAILED" with a `desc` when
 * it was not — with HTTP 200 either way.
 */
export function interpretTiaraResponse(httpStatus, data) {
  const code = data && data.statusCode !== undefined ? String(data.statusCode) : null;
  const status = data && data.status ? String(data.status).toUpperCase() : null;
  const accepted = httpStatus >= 200 && httpStatus < 300 && (code === '0' || status === 'SUCCESS');
  if (accepted) return { success: true };
  const detail = (data && (data.desc || data.message || data.error)) || `HTTP ${httpStatus}`;
  return { success: false, error: detail };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function postWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one SMS. Never throws: callers get { success, ... } and decide what
 * to tell the owner.
 *
 * @param {{ to: string, message: string }} sms
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, env?: object }} [options] test hooks
 * @returns {Promise<{ success: boolean, mock?: boolean, msgId?: string, cost?: string,
 *   balance?: string, to?: string, parts?: number, code?: string, data?: object, error?: string }>}
 */
export async function sendSMS({ to, message }, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, env = process.env } = {}) {
  const config = getSmsConfig(env);

  const text = toGsmText(message);
  if (!text) {
    return { success: false, code: 'empty_message', error: 'SMS message is empty' };
  }

  const msisdn = formatPhoneNumber(to);
  if (!msisdn) {
    console.error('[SMS] Refused: recipient is not a Kenyan mobile number');
    return { success: false, code: 'invalid_phone', error: 'Phone number is not a valid Kenyan mobile number' };
  }

  const parts = countSmsParts(text);
  if (parts > MAX_SMS_PARTS) {
    console.error(`[SMS] Refused: ${parts} parts for ${maskPhone(msisdn)} (limit ${MAX_SMS_PARTS})`);
    return { success: false, code: 'too_long', to: msisdn, parts, error: `SMS would be ${parts} parts; the limit is ${MAX_SMS_PARTS}` };
  }

  console.log(`[SMS] To ${maskPhone(msisdn)} from ${config.senderId} (${text.length} chars, ${parts} part(s))`);

  if (config.mock) {
    console.log(`[SMS MOCK] Not sent. Message:\n${text}\n`);
    return { success: true, mock: true, msgId: `mock_${Date.now()}`, to: msisdn, parts };
  }

  if (!config.apiKey) {
    console.error('[SMS] TIARA_API_KEY is not set; refusing to pretend the SMS was sent. Set it, or set it to "mock" for local development.');
    return { success: false, code: 'not_configured', to: msisdn, parts, error: 'TIARA_API_KEY is not configured' };
  }

  const payload = { to: msisdn, message: text, from: config.senderId };

  try {
    const response = await postWithTimeout(
      fetchImpl,
      `${config.baseUrl}/sendsms`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(payload)
      },
      timeoutMs
    );

    const data = await readJson(response);
    const verdict = interpretTiaraResponse(response.status, data);

    if (verdict.success) {
      console.log(`[SMS] Accepted by Tiara. msgId=${data?.msgId} cost=${data?.cost} balance=${data?.balance}`);
      return { success: true, msgId: data?.msgId, cost: data?.cost, balance: data?.balance, to: msisdn, parts, data };
    }

    console.error(`[SMS] Rejected by Tiara (HTTP ${response.status}): ${verdict.error}`, data);
    return { success: false, code: 'gateway_rejected', to: msisdn, parts, error: verdict.error, data };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `Tiara did not respond within ${timeoutMs}ms` : error.message;
    console.error('[SMS] Request failed:', reason);
    return { success: false, code: error?.name === 'AbortError' ? 'timeout' : 'network_error', to: msisdn, parts, error: reason };
  }
}

/**
 * Remaining credit, or null when it cannot be read. Skipped in mock mode.
 * @returns {Promise<{ balance: string, currency: string } | null>}
 */
export async function checkBalance({ fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, env = process.env } = {}) {
  const config = getSmsConfig(env);
  if (config.mock) return { balance: 'mock', currency: 'KES' };
  if (!config.apiKey) {
    console.error('[SMS] TIARA_API_KEY is not set; cannot check balance');
    return null;
  }

  try {
    const response = await postWithTimeout(
      fetchImpl,
      `${config.baseUrl}/checkbalance`,
      { method: 'GET', headers: { Authorization: `Bearer ${config.apiKey}` } },
      timeoutMs
    );
    const data = await readJson(response);
    if (!response.ok || !data || data.balance === undefined) {
      console.error(`[SMS] Balance check failed (HTTP ${response.status})`, data);
      return null;
    }
    console.log(`[SMS] Tiara balance: ${data.balance} ${data.currency || ''}`.trim());
    return { balance: data.balance, currency: data.currency || 'KES' };
  } catch (error) {
    console.error('[SMS] Balance check request failed:', error.message);
    return null;
  }
}
