import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SMS_PARTS,
  countSmsParts,
  formatPhoneNumber,
  maskPhone,
  sendSMS,
  toGsmText
} from '../services/sms.js';

const LIVE_ENV = { TIARA_API_KEY: 'test-key', TIARA_SENDER_ID: 'CONNECT' };

function fakeFetch(body = { status: 'SUCCESS', statusCode: '0', msgId: 'm1' }) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { status: 200, ok: true, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

describe('Kenyan mobile numbers only', () => {
  it('accepts Safaricom/Airtel/Telkom mobile ranges', () => {
    assert.equal(formatPhoneNumber('0702369124'), '254702369124');
    assert.equal(formatPhoneNumber('0110345678'), '254110345678');
    assert.equal(formatPhoneNumber(712345678), '254712345678');
  });

  it('refuses landlines and foreign numbers that would waste credit', () => {
    assert.equal(formatPhoneNumber('0202345678'), null);
    assert.equal(formatPhoneNumber('+1 555 123 4567'), null);
  });

  it('masks numbers for logs', () => {
    assert.equal(maskPhone('254712345678'), '2547****678');
  });
});

describe('GSM-7 folding', () => {
  it('replaces the characters that used to force Unicode billing', () => {
    assert.equal(toGsmText('28 Sep 2026 – 4 Oct 2026'), '28 Sep 2026 - 4 Oct 2026');
    assert.equal(toGsmText('sold at KSh 180 · KSh 150'), 'sold at KSh 180 - KSh 150');
    assert.equal(toGsmText('Mama’s “duka” …'), 'Mama\'s "duka" ...');
    assert.equal(toGsmText('a b c d'), 'a b c d');
  });

  it('keeps Swahili and GSM accents, strips the rest', () => {
    assert.equal(toGsmText('Ripoti ya Wiki'), 'Ripoti ya Wiki');
    assert.equal(toGsmText('Café crêpe'), 'Café crepe');
    assert.equal(toGsmText('Sukari \u{1F36C} 2kg'), 'Sukari 2kg');
  });

  it('counts billed parts, with extension characters costing two units', () => {
    assert.equal(countSmsParts('a'.repeat(160)), 1);
    assert.equal(countSmsParts('a'.repeat(161)), 2);
    assert.equal(countSmsParts('a'.repeat(306)), 2);
    assert.equal(countSmsParts('a'.repeat(307)), 3);
    assert.equal(countSmsParts(`${'a'.repeat(159)}|`), 2);
  });
});

describe('sendSMS cost guards', () => {
  it('sends the GSM-folded text to Tiara', async () => {
    const { impl, calls } = fakeFetch();
    const result = await sendSMS({ to: '0702369124', message: 'Week 1 – 7' }, { fetchImpl: impl, env: LIVE_ENV });
    assert.equal(result.success, true);
    assert.equal(calls[0].message, 'Week 1 - 7');
    assert.equal(result.parts, 1);
    assert.equal(result.to, '254702369124');
  });

  it('refuses a message over the part limit without calling Tiara', async () => {
    const { impl, calls } = fakeFetch();
    const result = await sendSMS({ to: '0702369124', message: 'a'.repeat(153 * MAX_SMS_PARTS + 1) }, { fetchImpl: impl, env: LIVE_ENV });
    assert.equal(result.success, false);
    assert.equal(result.code, 'too_long');
    assert.equal(calls.length, 0);
  });

  it('labels failures with a code the app can explain', async () => {
    const { impl } = fakeFetch({ status: 'FAILED', statusCode: '408', desc: 'Sender id not whitelisted' });
    const rejected = await sendSMS({ to: '0702369124', message: 'hi' }, { fetchImpl: impl, env: LIVE_ENV });
    assert.equal(rejected.code, 'gateway_rejected');
    const invalid = await sendSMS({ to: '12', message: 'hi' }, { fetchImpl: impl, env: LIVE_ENV });
    assert.equal(invalid.code, 'invalid_phone');
  });
});
