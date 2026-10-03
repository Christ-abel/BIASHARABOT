import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_LABELS_EN, REPORT_LABEL_KEYS, buildReportMessage, computeReportFigures } from '../report.js';
import { clearTranslationCache, getReportLabels, validateTranslation } from '../translate.js';

const goodSwahili = Object.fromEntries(REPORT_LABEL_KEYS.map((k) => [k, `sw:${k}`]));
const originalKey = process.env.GEMINI_API_KEY;

beforeEach(() => {
  clearTranslationCache();
  // A real-looking key so the Gemini path (with an injected translator) is taken.
  process.env.GEMINI_API_KEY = 'test-key';
});

afterEach(() => {
  process.env.GEMINI_API_KEY = originalKey;
});

describe('getReportLabels', () => {
  test('English never calls the translator', async () => {
    let calls = 0;
    const result = await getReportLabels('en', { translate: async () => { calls++; return goodSwahili; } });
    assert.equal(calls, 0);
    assert.deepEqual(result, { language: 'en', labels: REPORT_LABELS_EN, fallback: false });
  });

  test('a missing or unsupported language means English, not a failure', async () => {
    for (const lang of [undefined, null, '', 'fr', 'xx']) {
      const result = await getReportLabels(lang, { translate: async () => goodSwahili });
      assert.equal(result.language, 'en');
      assert.equal(result.labels, REPORT_LABELS_EN);
      assert.equal(result.fallback, false);
    }
  });

  test('returns and caches a valid translation', async () => {
    let calls = 0;
    const translate = async () => { calls++; return { ...goodSwahili, revenue: '  Mapato  ' }; };

    const first = await getReportLabels('sw', { translate });
    assert.equal(first.language, 'sw');
    assert.equal(first.fallback, false);
    assert.equal(first.labels.revenue, 'Mapato', 'values are trimmed');

    const second = await getReportLabels('sw', { translate });
    assert.equal(calls, 1, 'second call served from cache');
    assert.equal(second.labels, first.labels);
  });

  test('falls back to English when the translator throws', async () => {
    const result = await getReportLabels('sw', { translate: async () => { throw new Error('quota'); } });
    assert.deepEqual(result, { language: 'en', labels: REPORT_LABELS_EN, fallback: true });
  });

  test('falls back to English when the translator times out', async () => {
    const neverResolves = () => new Promise(() => {});
    const result = await getReportLabels('sw', { translate: neverResolves, timeoutMs: 20 });
    assert.deepEqual(result, { language: 'en', labels: REPORT_LABELS_EN, fallback: true });
  });

  test('rejects translations with missing keys, empty values or digits', async () => {
    const cases = [
      null,
      'not an object',
      { ...goodSwahili, net_profit: undefined },
      { ...goodSwahili, shop: '   ' },
      { ...goodSwahili, revenue: 'Mapato KSh 500' }
    ];
    for (const bad of cases) {
      clearTranslationCache();
      const result = await getReportLabels('sw', { translate: async () => bad });
      assert.equal(result.language, 'en');
      assert.equal(result.fallback, true);
    }
  });

  test('a failed translation is not cached, so the next report retries', async () => {
    let calls = 0;
    const translate = async () => { calls++; if (calls === 1) throw new Error('flaky'); return goodSwahili; };
    const first = await getReportLabels('sw', { translate });
    const second = await getReportLabels('sw', { translate });
    assert.equal(first.fallback, true);
    assert.equal(second.fallback, false);
    assert.equal(calls, 2);
  });

  test('mock mode uses the built-in Swahili labels without calling Gemini', async () => {
    process.env.GEMINI_API_KEY = 'mock';
    const result = await getReportLabels('sw');
    assert.equal(result.language, 'sw');
    assert.equal(result.fallback, false);
    assert.equal(result.labels.revenue, 'Mapato');
    assert.ok(validateTranslation(result.labels));
  });

  test('translated and English reports carry identical amounts', async () => {
    const figures = computeReportFigures([
      { type: 'sale', total: 4200 },
      { type: 'purchase', total: 1999.99 },
      { type: 'expense', total: 10, source: 'payhero' }
    ]);
    const { labels } = await getReportLabels('sw', { translate: async () => goodSwahili });
    const amounts = (t) => t.match(/KSh -?\d+\.\d{2}/g);
    const en = buildReportMessage({ businessName: 'Duka', ...figures });
    const sw = buildReportMessage({ businessName: 'Duka', labels, ...figures });
    assert.deepEqual(amounts(sw), amounts(en));
    assert.match(sw, /sw:net_profit: KSh 2190\.01/);
  });
});

describe('validateTranslation', () => {
  test('accepts the English dictionary itself', () => {
    assert.equal(validateTranslation(REPORT_LABELS_EN), true);
  });
  test('rejects extra-digit and missing-key payloads', () => {
    assert.equal(validateTranslation({ ...REPORT_LABELS_EN, footer: 'v2' }), false);
    const { footer, ...missing } = REPORT_LABELS_EN;
    assert.equal(validateTranslation(missing), false);
  });
});
