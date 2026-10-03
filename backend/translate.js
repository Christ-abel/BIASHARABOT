/**
 * Report label translation.
 *
 * Gemini is asked to translate the fixed set of report labels for a language,
 * once, and the result is cached for the life of the process. It never sees a
 * figure: amounts are formatted and inserted by report.js after translation.
 * Anything that goes wrong — timeout, API error, malformed or suspicious
 * output — is logged and the English labels are used instead.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  DEFAULT_LANGUAGE,
  REPORT_LABELS_EN,
  REPORT_LABEL_KEYS,
  SUPPORTED_LANGUAGES,
  isSupportedLanguage
} from './report.js';

export const TRANSLATE_TIMEOUT_MS = 5000;

// Used when GEMINI_API_KEY is 'mock', matching the mock mode of the parsers in
// gemini.js, so a translated report can be seen locally without API charges.
const MOCK_TRANSLATIONS = {
  sw: {
    title_weekly: 'Ripoti ya Wiki ya BiasharaGPT',
    title_daily: 'Ripoti ya Siku ya BiasharaGPT',
    shop: 'Duka',
    revenue: 'Mapato',
    cost_of_goods: 'Gharama ya Bidhaa',
    other_expenses: 'Matumizi Mengine',
    mpesa_fees: 'Ada za M-Pesa',
    net_profit: 'Faida Halisi',
    outstanding_credit: 'Deni Linalodaiwa',
    printed_at: 'Imechapishwa tarehe',
    footer: 'Inaendeshwa na BiasharaGPT!'
  }
};

const cache = new Map();

const isMockMode = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  return !apiKey || apiKey === 'mock' || apiKey.trim() === '';
};

/**
 * Accepts a translation only if it has every label key, every value is a
 * non-empty string, and none of them contain a digit — a digit means the
 * model started inventing figures, which a report must never carry.
 */
export function validateTranslation(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  return REPORT_LABEL_KEYS.every((key) => {
    const value = candidate[key];
    return typeof value === 'string' && value.trim().length > 0 && !/\d/.test(value);
  });
}

async function translateWithGemini(language) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
  const languageName = SUPPORTED_LANGUAGES[language];

  const prompt = `Translate the values of the following JSON object from English into ${languageName}.
These are labels for a small shop's financial report sent by SMS in Kenya.

${JSON.stringify(REPORT_LABELS_EN, null, 2)}

Rules:
- Return a JSON object with exactly the same keys and translated string values.
- Keep translations short so they fit in an SMS.
- Keep the product name "BiasharaGPT" and the word "M-Pesa" unchanged.
- Do not add numbers, amounts, currency or any extra text.`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' }
  });
  return JSON.parse(result.response.text());
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Translation timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolves the labels to use for a report in `language`.
 *
 * @param {string} language ISO 639-1 code; anything unsupported means English.
 * @param {{ translate?: (language: string) => Promise<object>, timeoutMs?: number }} [options]
 *   `translate` can be injected (tests) and defaults to Gemini.
 * @returns {Promise<{ language: string, labels: object, fallback: boolean }>}
 *   `fallback` is true when English was used although another language was asked for.
 */
export async function getReportLabels(language, { translate = translateWithGemini, timeoutMs = TRANSLATE_TIMEOUT_MS } = {}) {
  if (!isSupportedLanguage(language) || language === DEFAULT_LANGUAGE) {
    if (language && !isSupportedLanguage(language)) {
      console.warn(`[REPORT LANGUAGE] Unsupported language "${language}"; using English`);
    }
    return { language: DEFAULT_LANGUAGE, labels: REPORT_LABELS_EN, fallback: false };
  }

  if (cache.has(language)) {
    return { language, labels: cache.get(language), fallback: false };
  }

  if (isMockMode() && translate === translateWithGemini) {
    const labels = MOCK_TRANSLATIONS[language];
    if (labels) {
      console.log(`[REPORT LANGUAGE] Mock mode: using built-in ${language} labels`);
      return { language, labels, fallback: false };
    }
    console.warn(`[REPORT LANGUAGE] Mock mode has no ${language} labels; using English`);
    return { language: DEFAULT_LANGUAGE, labels: REPORT_LABELS_EN, fallback: true };
  }

  try {
    const candidate = await withTimeout(translate(language), timeoutMs);
    if (!validateTranslation(candidate)) {
      throw new Error('Translation rejected: missing keys, empty values or digits in labels');
    }
    const labels = Object.freeze(Object.fromEntries(REPORT_LABEL_KEYS.map((k) => [k, candidate[k].trim()])));
    cache.set(language, labels);
    console.log(`[REPORT LANGUAGE] Cached ${language} report labels`);
    return { language, labels, fallback: false };
  } catch (error) {
    console.error(`[REPORT LANGUAGE] Translation to ${language} failed; falling back to English:`, error.message);
    return { language: DEFAULT_LANGUAGE, labels: REPORT_LABELS_EN, fallback: true };
  }
}

/** Test hook: forget cached translations. */
export function clearTranslationCache() {
  cache.clear();
}
