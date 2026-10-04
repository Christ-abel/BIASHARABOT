import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNoticeMessage, dispatchComplianceNotices } from '../compliance-notices.js';
import { COMPLIANCE_LABELS } from '../report-labels.js';

/** In-memory ComplianceNotice, unique on the same four fields as the model. */
function memoryStore() {
  const rows = [];
  let nextId = 1;
  const key = (r) => [r.business_id, r.obligation_id, r.notice_type, r.window_key].join('|');
  return {
    rows,
    async create(doc) {
      if (rows.some((row) => key(row) === key(doc))) {
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      const row = { _id: nextId++, ...doc };
      rows.push(row);
      return row;
    },
    async updateOne(filter, update) {
      const row = rows.find((r) => r._id === filter._id);
      if (row) Object.assign(row, update.$set);
    },
    async deleteOne(filter) {
      const index = rows.findIndex((r) => r._id === filter._id);
      if (index >= 0) rows.splice(index, 1);
    }
  };
}

const business = { id: 'mama-njeri', name: 'Mama Njeri Duka', phone: '254712345678', reportLanguage: 'en' };
const evaluation = {
  triggers: [{ id: 'threshold_tot', windowKey: 'threshold:tot', titleKey: 'thresholdTot', vars: { min: 1_000_000 } }],
  obligations: []
};

describe('compliance SMS notices', () => {
  it('sends a threshold notice once and skips it on the next visit', async () => {
    const store = memoryStore();
    let sends = 0;
    const send = async () => { sends += 1; return { success: true, msgId: 'ref_1' }; };

    const first = await dispatchComplianceNotices({ business, evaluation, send, store });
    const second = await dispatchComplianceNotices({ business, evaluation, send, store });

    assert.equal(first.sent.length, 1);
    assert.equal(second.skipped.length, 1);
    assert.equal(sends, 1);
    assert.equal(store.rows[0].status, 'sent');
  });

  it('does not mark a failed SMS as sent, so the next visit retries it', async () => {
    const store = memoryStore();
    const failing = async () => ({ success: false, code: 'timeout', error: 'SMS gateway did not answer in time' });

    const result = await dispatchComplianceNotices({ business, evaluation, send: failing, store });

    assert.equal(result.sent.length, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].reason, 'timeout');
    assert.equal(store.rows.length, 0);

    let sends = 0;
    const retry = await dispatchComplianceNotices({
      business, evaluation, store, send: async () => { sends += 1; return { success: true }; }
    });
    assert.equal(retry.sent.length, 1);
    assert.equal(sends, 1);
  });

  it('claims the notice before sending, so racing visits send once', async () => {
    const store = memoryStore();
    let sends = 0;
    const send = async () => { sends += 1; await new Promise((r) => setImmediate(r)); return { success: true }; };

    await Promise.all([
      dispatchComplianceNotices({ business, evaluation, send, store }),
      dispatchComplianceNotices({ business, evaluation, send, store })
    ]);
    assert.equal(sends, 1);
  });

  it('phrases the threshold SMS once, without repeating itself', () => {
    const message = buildNoticeMessage({
      labels: COMPLIANCE_LABELS.en,
      shopName: 'Mama Njeri Duka',
      trigger: evaluation.triggers[0]
    });
    assert.match(message, /^BiasharaBot \(Mama Njeri Duka\): Your turnover has entered the Turnover Tax band/);
    assert.equal(message.match(/Your turnover has entered/g).length, 1);
    assert.doesNotMatch(message, /now applies/);

    const sw = buildNoticeMessage({ labels: COMPLIANCE_LABELS.sw, shopName: 'Mama Njeri Duka', trigger: evaluation.triggers[0] });
    assert.equal(sw.match(/Mauzo yako/g).length, 1);
  });
});
