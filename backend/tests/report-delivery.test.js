import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCHEDULED_ATTEMPTS,
  runWeeklyReportJob,
  sendShopReportSms,
  weeklyDedupeKey
} from '../report-delivery.js';

/** In-memory stand-in for the ReportDelivery model, unique on dedupe_key. */
function memoryStore() {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    async create(doc) {
      if (doc.dedupe_key && rows.some((row) => row.dedupe_key === doc.dedupe_key)) {
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      const row = { _id: nextId++, ...doc };
      rows.push(row);
      return row;
    },
    async findOneAndUpdate(filter, update) {
      const row = rows.find((r) => r.dedupe_key === filter.dedupe_key
        && r.status === filter.status
        && r.attempts < filter.attempts.$lt);
      if (!row) return null;
      Object.assign(row, update.$set);
      row.attempts += update.$inc.attempts;
      return row;
    },
    async updateOne(filter, update) {
      const row = rows.find((r) => r._id === filter._id);
      if (row) Object.assign(row, update.$set);
    }
  };
}

const PERIOD = { start: '2026-09-28', end: '2026-10-04' };
const shop = (id = 'mama-njeri') => ({ id, name: 'Mama Njeri Duka', phone: '254712345678' });
const fakeReport = (entryCount = 3) => async () => ({
  period: PERIOD,
  entryCount,
  localized: { sms: 'BiasharaBot Weekly Report' }
});
const okSend = () => {
  const calls = [];
  const send = async ({ to, message }) => {
    calls.push({ to, message });
    return { success: true, mock: true, msgId: `ref_${calls.length}`, to, parts: 1 };
  };
  return { calls, send };
};

describe('scheduled weekly till-slip SMS', () => {
  it('sends once per shop per week, however often the job runs', async () => {
    const store = memoryStore();
    const { calls, send } = okSend();
    const options = { trigger: 'schedule', store, send, buildReport: fakeReport() };

    const first = await sendShopReportSms(shop(), options);
    const second = await sendShopReportSms(shop(), options);

    assert.equal(first.outcome, 'sent');
    assert.equal(second.outcome, 'skipped');
    assert.equal(calls.length, 1);
    assert.equal(store.rows[0].dedupe_key, weeklyDedupeKey('mama-njeri', PERIOD));
    assert.equal(store.rows[0].status, 'sent');
    assert.equal(store.rows[0].ref_id, 'ref_1');
  });

  it('writes the claim before sending, so overlapping runs cannot both send', async () => {
    const store = memoryStore();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let sends = 0;
    const slowSend = async ({ to }) => {
      sends += 1;
      await gate;
      return { success: true, msgId: 'ref_slow', to, parts: 1 };
    };
    const options = { trigger: 'schedule', store, send: slowSend, buildReport: fakeReport() };

    const racing = [sendShopReportSms(shop(), options), sendShopReportSms(shop(), options)];
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const outcomes = (await Promise.all(racing)).map((r) => r.outcome).sort();

    assert.deepEqual(outcomes, ['sent', 'skipped']);
    assert.equal(sends, 1);
  });

  it('retries a failed send on a later run, up to the attempt limit', async () => {
    const store = memoryStore();
    let sends = 0;
    const failing = async ({ to }) => {
      sends += 1;
      return { success: false, code: 'timeout', error: 'SMS gateway did not answer in time', to, parts: 1 };
    };
    const options = { trigger: 'schedule', store, send: failing, buildReport: fakeReport() };

    const outcomes = [];
    for (let run = 0; run < MAX_SCHEDULED_ATTEMPTS + 2; run += 1) {
      outcomes.push((await sendShopReportSms(shop(), options)).outcome);
    }

    assert.equal(sends, MAX_SCHEDULED_ATTEMPTS);
    assert.deepEqual(outcomes.slice(0, MAX_SCHEDULED_ATTEMPTS), Array(MAX_SCHEDULED_ATTEMPTS).fill('failed'));
    assert.deepEqual(outcomes.slice(MAX_SCHEDULED_ATTEMPTS), ['skipped', 'skipped']);
    assert.equal(store.rows[0].status, 'failed');
    assert.equal(store.rows[0].error_code, 'timeout');
  });

  it('does not text a shop that logged nothing this week', async () => {
    const store = memoryStore();
    const { calls, send } = okSend();
    const result = await sendShopReportSms(shop(), {
      trigger: 'schedule', store, send, buildReport: fakeReport(0)
    });
    assert.equal(result.outcome, 'quiet');
    assert.equal(calls.length, 0);
    assert.equal(store.rows.length, 0);
  });

  it('always sends to the phone saved on the shop', async () => {
    const store = memoryStore();
    const { calls, send } = okSend();
    await sendShopReportSms({ ...shop(), phone: '254799000111' }, {
      trigger: 'manual', store, send, buildReport: fakeReport()
    });
    assert.equal(calls[0].to, '254799000111');
  });

  it('lets the owner resend manually without touching the weekly claim', async () => {
    const store = memoryStore();
    const { calls, send } = okSend();
    const build = fakeReport();
    await sendShopReportSms(shop(), { trigger: 'schedule', store, send, buildReport: build });
    const manual = await sendShopReportSms(shop(), { trigger: 'manual', store, send, buildReport: build });
    assert.equal(manual.outcome, 'sent');
    assert.equal(calls.length, 2);
    assert.equal(store.rows[1].dedupe_key, undefined);
  });

  it('runs every shop and summarises the outcomes', async () => {
    const store = memoryStore();
    const { send } = okSend();
    const shops = [shop('a'), shop('b'), { id: 'c', name: 'No phone' }];
    const summary = await runWeeklyReportJob({
      listBusinesses: () => shops,
      store,
      send,
      buildReport: fakeReport()
    });
    assert.equal(summary.sent, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.errors, 0);
  });
});
