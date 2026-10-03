import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BASE_URL,
  DEFAULT_SENDER_ID,
  checkBalance,
  formatPhoneNumber,
  getSmsConfig,
  interpretTiaraResponse,
  sendSMS
} from '../services/sms.js';

const LIVE_ENV = { TIARA_API_KEY: 'test-key', TIARA_SENDER_ID: 'CONNECT' };

/** Fake fetch that records the request and answers with the given body. */
function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, payload: options.body ? JSON.parse(options.body) : null });
    return { status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
  return { impl, calls };
}

describe('formatPhoneNumber', () => {
  test('normalises Kenyan numbers to 254 format', () => {
    assert.equal(formatPhoneNumber('0743177132'), '254743177132');
    assert.equal(formatPhoneNumber('+254 743 177 132'), '254743177132');
    assert.equal(formatPhoneNumber('254743177132'), '254743177132');
    assert.equal(formatPhoneNumber('743177132'), '254743177132');
  });
  test('rejects things that cannot be a number', () => {
    assert.equal(formatPhoneNumber(''), null);
    assert.equal(formatPhoneNumber(undefined), null);
    assert.equal(formatPhoneNumber('12345'), null);
    assert.equal(formatPhoneNumber('25474317713'), null);
  });
});

describe('getSmsConfig', () => {
  test('applies defaults and detects mock mode', () => {
    assert.deepEqual(getSmsConfig({}), { apiKey: '', mock: false, baseUrl: DEFAULT_BASE_URL, senderId: DEFAULT_SENDER_ID });
    assert.equal(getSmsConfig({ TIARA_API_KEY: ' mock ' }).mock, true);
    assert.equal(getSmsConfig({ TIARA_BASE_URL: 'https://x.test/api/' }).baseUrl, 'https://x.test/api');
  });
});

describe('interpretTiaraResponse', () => {
  test('HTTP 200 with FAILED status is a failure with Tiara\'s reason', () => {
    const verdict = interpretTiaraResponse(200, { status: 'FAILED', statusCode: '408', desc: "Sender id 'X' not whitelisted" });
    assert.equal(verdict.success, false);
    assert.match(verdict.error, /not whitelisted/);
  });
  test('statusCode 0 or status SUCCESS is accepted', () => {
    assert.equal(interpretTiaraResponse(200, { statusCode: '0' }).success, true);
    assert.equal(interpretTiaraResponse(200, { status: 'SUCCESS' }).success, true);
    assert.equal(interpretTiaraResponse(200, { statusCode: 0, status: 'SUCCESS' }).success, true);
  });
  test('non-2xx is a failure even if the body looks fine', () => {
    assert.equal(interpretTiaraResponse(401, { statusCode: '0' }).success, false);
    assert.equal(interpretTiaraResponse(500, null).error, 'HTTP 500');
  });
});

describe('sendSMS', () => {
  test('sends exactly { to, message, from } with a bearer header', async () => {
    const { impl, calls } = fakeFetch(200, { status: 'SUCCESS', statusCode: '0', msgId: 'abc', cost: 'KES 0.6', balance: 'KES 9' });
    const result = await sendSMS({ to: '0743177132', message: 'hi' }, { fetchImpl: impl, env: LIVE_ENV });

    assert.equal(result.success, true);
    assert.equal(result.msgId, 'abc');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/sendsms`);
    assert.deepEqual(calls[0].payload, { to: '254743177132', message: 'hi', from: 'CONNECT' });
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  });

  test('reports Tiara FAILED as failure despite HTTP 200', async () => {
    const { impl } = fakeFetch(200, { status: 'FAILED', statusCode: '408', desc: 'Sender id not whitelisted' });
    const result = await sendSMS({ to: '0743177132', message: 'hi' }, { fetchImpl: impl, env: LIVE_ENV });
    assert.equal(result.success, false);
    assert.match(result.error, /not whitelisted/);
  });

  test('reports HTTP errors and non-JSON bodies as failure', async () => {
    const { impl } = fakeFetch(401, undefined);
    const result = await sendSMS({ to: '0743177132', message: 'hi' }, { fetchImpl: impl, env: LIVE_ENV });
    assert.equal(result.success, false);
    assert.equal(result.error, 'HTTP 401');
  });

  test('mock mode does not call the network and says so', async () => {
    const { impl, calls } = fakeFetch(200, {});
    const result = await sendSMS({ to: '0743177132', message: 'hi' }, { fetchImpl: impl, env: { TIARA_API_KEY: 'mock' } });
    assert.equal(result.success, true);
    assert.equal(result.mock, true);
    assert.equal(calls.length, 0);
  });

  test('an empty API key is a failure, not a silent mock', async () => {
    const { impl, calls } = fakeFetch(200, {});
    const result = await sendSMS({ to: '0743177132', message: 'hi' }, { fetchImpl: impl, env: { TIARA_API_KEY: '' } });
    assert.equal(result.success, false);
    assert.match(result.error, /TIARA_API_KEY/);
    assert.equal(calls.length, 0);
  });

  test('rejects an invalid phone number or empty message before sending', async () => {
    const { impl, calls } = fakeFetch(200, {});
    assert.equal((await sendSMS({ to: '12', message: 'hi' }, { fetchImpl: impl, env: LIVE_ENV })).success, false);
    assert.equal((await sendSMS({ to: '0743177132', message: '  ' }, { fetchImpl: impl, env: LIVE_ENV })).success, false);
    assert.equal(calls.length, 0);
  });

  test('times out instead of hanging', async () => {
    const hang = (url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const result = await sendSMS({ to: '0743177132', message: 'hi' }, { fetchImpl: hang, env: LIVE_ENV, timeoutMs: 20 });
    assert.equal(result.success, false);
    assert.match(result.error, /did not respond within 20ms/);
  });
});

describe('checkBalance', () => {
  test('returns the balance on success and null on a bad response', async () => {
    const ok = fakeFetch(200, { balance: '12.63', currency: 'KES' });
    assert.deepEqual(await checkBalance({ fetchImpl: ok.impl, env: LIVE_ENV }), { balance: '12.63', currency: 'KES' });
    assert.equal(ok.calls[0].url, `${DEFAULT_BASE_URL}/checkbalance`);

    const empty = fakeFetch(200, undefined);
    assert.equal(await checkBalance({ fetchImpl: empty.impl, env: LIVE_ENV }), null);
  });
  test('skips the network in mock mode and with no key', async () => {
    const { impl, calls } = fakeFetch(200, {});
    assert.deepEqual(await checkBalance({ fetchImpl: impl, env: { TIARA_API_KEY: 'mock' } }), { balance: 'mock', currency: 'KES' });
    assert.equal(await checkBalance({ fetchImpl: impl, env: {} }), null);
    assert.equal(calls.length, 0);
  });
});
