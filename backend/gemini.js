import { GoogleGenerativeAI } from '@google/generative-ai';
import { attachPhrases, coerceParsedEntries, parseShopTalk } from './parse-entry.js';
import { normalizeReportLanguage } from './languages.js';

const getGenAI = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'mock' || apiKey.trim() === '') {
    return null;
  }
  return new GoogleGenerativeAI(apiKey);
};

/**
 * gemini-3.5-flash free tier is 20 requests/day. When it 429s we used to
 * fall through to a toy parser that invented "Loaves / Bread". Walk a
 * short model list instead — 3.8 / 3.5-lite still accept audio + images.
 */
export function geminiModelCandidates() {
  const preferred = String(process.env.GEMINI_MODEL || '').trim();
  const list = [
    preferred,
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-2.5-flash',
    'gemini-3.5-flash'
  ];
  return [...new Set(list.filter(Boolean))];
}

function isRetryableModelError(error) {
  const status = error?.status || error?.statusCode;
  if (status === 404 || status === 429 || status === 403) return true;
  const message = String(error?.message || '');
  return /not found|quota|rate.?limit|429|404|403|overloaded|unavailable|503/i.test(message);
}

export function geminiAudioMime(mimeType) {
  const raw = String(mimeType || '').toLowerCase();
  const base = raw.split(';')[0].trim();
  if (base.includes('ogg')) return 'audio/ogg';
  if (base.includes('mp4') || base.includes('m4a')) return 'audio/mp4';
  if (base.includes('aac')) return 'audio/aac';
  if (base.includes('mpeg') || base.includes('mp3')) return 'audio/mp3';
  if (base.includes('wav')) return 'audio/wav';
  if (base.includes('webm')) return 'audio/webm';
  return base || 'audio/webm';
}

async function generateJson(parts, { label = 'gemini' } = {}) {
  const genAI = getGenAI();
  if (!genAI) return null;

  const models = geminiModelCandidates();
  let lastError = null;

  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 2048
        }
      });
      const text = result.response.text();
      const parsed = JSON.parse(text);
      console.log(`[GEMINI] ${label} used ${modelName}`);
      return parsed;
    } catch (error) {
      lastError = error;
      if (isRetryableModelError(error)) {
        console.warn(`[GEMINI] ${label} ${modelName} failed (${error.status || error.message}); trying next model`);
        continue;
      }
      console.error(`[GEMINI] ${label} ${modelName} hard error:`, error.message || error);
      break;
    }
  }

  if (lastError) {
    console.error(`[GEMINI] ${label} exhausted models:`, lastError.message || lastError);
  }
  return null;
}

function shopTalkPrompt(language) {
  const lang = normalizeReportLanguage(language);
  return `You parse Kenyan duka (shop) talk. Owners mix English, Kiswahili and Sheng.
"bob" means Kenyan Shilling. "twenty bob" is 20. "ishirini" is 20. "thelathini" is 30.

Return JSON only:
{
  "transcription": string,
  "items": [
    { "type": "sale" | "purchase" | "expense" | "credit", "item": string, "qty": number, "unit_price": number, "total": number }
  ]
}

Rules:
- One spoken or typed line can list SEVERAL products. "Ugali twenty bob, nyama thirty bob" is TWO sales: Ugali qty 1 at 20, Nyama qty 1 at 30.
- Keep the product name the owner said (Ugali, nyama, sukari). Do not rename ugali to maize flour.
- Default type is sale unless they said bought/nunua (purchase), rent/stima (expense), or deni/credit.
- qty defaults to 1 when they only name a price. total = qty × unit_price.
- Pack sizes like 2kg stay in the item name. "sold 3 sugar 2kg at 280" is sugar 2kg, qty 3, unit_price 280.
- transcription is what they said, in the language they used.
- Write item names in ${lang === 'sw' ? 'Kiswahili if they spoke Kiswahili, otherwise as said' : 'the words they used'}.
- If there is no real transaction, return {"error":"Could not understand that entry."}.`;
}

function finalizeEntries(parsed, originalText, language) {
  const fromModel = coerceParsedEntries(parsed, originalText, language);
  const fromLocal = attachPhrases(parseShopTalk(originalText || parsed?.transcription || ''), language, originalText);
  const localClean = coerceParsedEntries({ items: fromLocal }, originalText, language);

  // Prefer a local multi-item split when Gemini collapsed everything into one row.
  if (localClean.length > fromModel.length) return localClean;
  if (fromModel.length) {
    return fromModel.map((row) => ({
      ...row,
      transcription: row.transcription || parsed?.transcription || originalText
    }));
  }
  return localClean;
}

export async function parseTextWithGemini(text, options = {}) {
  const language = normalizeReportLanguage(options.language);
  const local = attachPhrases(parseShopTalk(text), language, text);
  const localClean = coerceParsedEntries({ items: local }, text, language);

  // Kenyan price lists do not need a model. Save quota for voice and receipts.
  if (localClean.length) {
    return { items: localClean, transcription: text, source: 'local' };
  }

  const genAI = getGenAI();
  if (!genAI) {
    return localClean.length
      ? { items: localClean, transcription: text, source: 'local' }
      : { error: 'Could not determine an amount for that entry' };
  }

  const parsed = await generateJson(
    [{ text: `${shopTalkPrompt(language)}\n\nText: ${JSON.stringify(text)}` }],
    { label: 'text' }
  );

  if (!parsed || parsed.error) {
    return localClean.length
      ? { items: localClean, transcription: text, source: 'local' }
      : { error: parsed?.error || 'Could not determine an amount for that entry' };
  }

  const items = finalizeEntries(parsed, text, language);
  if (!items.length) return { error: 'Could not determine an amount for that entry' };
  return { items, transcription: parsed.transcription || text, source: 'gemini' };
}

export async function parseAudioWithGemini(audioBuffer, mimeType, options = {}) {
  const language = normalizeReportLanguage(options.language);
  const genAI = getGenAI();
  if (!genAI) {
    return { error: 'Voice notes need a Gemini API key. Type the sale while the key is missing.' };
  }

  if (!audioBuffer || audioBuffer.length < 800) {
    return { error: 'That recording was too short. Hold the mic and say the items, for example: Ugali twenty bob, nyama thirty bob.' };
  }

  const parsed = await generateJson(
    [
      { text: `${shopTalkPrompt(language)}\n\nTranscribe this voice note first, then split every product into items.` },
      {
        inlineData: {
          mimeType: geminiAudioMime(mimeType),
          data: audioBuffer.toString('base64')
        }
      }
    ],
    { label: 'audio' }
  );

  if (!parsed || parsed.error) {
    return {
      error: parsed?.error
        || 'Could not understand the recording. Speak closer to the phone: Ugali twenty bob, nyama thirty bob.'
    };
  }

  const spoken = String(parsed.transcription || '').trim();
  const items = finalizeEntries(parsed, spoken, language);
  if (!items.length) {
    return {
      error: spoken
        ? `Heard “${spoken}” but could not find a price. Say it like: Ugali twenty bob.`
        : 'Could not understand the recording. Please repeat clearly.'
    };
  }

  return { items, transcription: spoken, source: 'gemini' };
}

/**
 * Receipt vision. Gemini already accepts images the same way parseAudioWithGemini
 * sends audio (inlineData + prompt) — no extra vendor or SDK.
 *
 * When GEMINI_API_KEY is "mock" (or missing) we return a fixed sample so the
 * feature can be built and tested without API charges.
 */
export const MOCK_RECEIPT = {
  supplier: 'Nairobi Wholesalers Ltd',
  date: '2026-03-28',
  line_items: [
    { item: 'Sugar 2kg', qty: 10, unit_cost: 280, total: 2800 },
    { item: 'Cooking Oil 1L', qty: 12, unit_cost: 250, total: 3000 },
    { item: 'Maize Flour 2kg', qty: 20, unit_cost: 150, total: 3000 },
    { item: 'Bar Soap', qty: 24, unit_cost: 80, total: 1920 }
  ]
};

export async function parseReceiptWithGemini(imageBuffer, mimeType) {
  const genAI = getGenAI();
  if (!genAI) {
    console.log('Mock Mode: Parsing receipt locally without Gemini API key');
    return { ...MOCK_RECEIPT, line_items: MOCK_RECEIPT.line_items.map((row) => ({ ...row })) };
  }

  const parsed = await generateJson(
    [
      {
        text: `You are reading a supplier receipt or till slip from a Kenyan shop (duka).
Extract every purchased line item. Photos may be blurry, cropped, or in Swahili.

If the image is blank, unreadable, not a receipt, or has no purchasable line items, return:
{
  "error": "Could not read this receipt. Try a clearer photo or enter the stock by hand."
}

Otherwise return a valid JSON object matching this schema:
{
  "supplier": string,
  "date": string,
  "line_items": [
    { "item": string, "qty": number, "unit_cost": number, "total": number }
  ]
}

Instructions:
- "supplier" is the shop or wholesaler name printed on the receipt. Empty string if missing.
- "date" is ISO YYYY-MM-DD when you can read a date, otherwise empty string.
- Each line_item is one product the shop bought (inventory), not tax or change.
- qty is the number of units. unit_cost is the price of one unit in Kenyan Shillings.
- total MUST equal qty × unit_cost. If the slip only shows a line total, divide by qty.
- If a line is too faint to trust, omit it rather than guessing a number.
- Keep item names short and clear (English or common Kenyan shop names: sugar, maize flour, cooking oil, unga, mafuta).
- Ignore headers, till numbers, cashier names, VAT summaries, and "amount tendered".`
      },
      {
        inlineData: {
          mimeType: mimeType || 'image/jpeg',
          data: imageBuffer.toString('base64')
        }
      }
    ],
    { label: 'receipt' }
  );

  if (!parsed) {
    return { error: 'Could not read this receipt. Try a clearer photo or enter the stock by hand.' };
  }
  return parsed;
}

/**
 * Phrase surrounding report / compliance text in another language.
 * Callers must never put figures, dates or item names in `phrases` —
 * those stay in the template and are interpolated after this returns.
 *
 * Mock mode throws so resolveReportLabels() can exercise the English
 * fallback the same way a timeout or API outage would.
 */
export async function translatePhrasesWithGemini(phrases, targetLanguage) {
  const genAI = getGenAI();
  if (!genAI) {
    throw new Error('Gemini unavailable (mock mode) — cannot translate phrases');
  }

  const parsed = await generateJson(
    [{
      text: `Translate the JSON string values into language code "${targetLanguage}".
Keep every key unchanged. Do not add keys. Do not change digits, currency codes, or placeholders like {count}, {min}, {deadline}.
Return only a JSON object with the same keys.

Input:
${JSON.stringify(phrases)}`
    }],
    { label: 'translate' }
  );

  if (!parsed) {
    throw new Error('Gemini unavailable — cannot translate phrases');
  }
  return parsed;
}
