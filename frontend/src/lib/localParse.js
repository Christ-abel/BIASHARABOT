/**
 * On-device fallback parser for transactions typed while offline.
 *
 * Gemini does the real parsing on the server. Offline we still want the duka
 * owner to see a number instead of "pending", so this reads the obvious
 * quantity/price shapes in English and Swahili. Whatever it produces is
 * provisional: when the entry syncs, the server's parse replaces it.
 *
 * Returns null when it cannot find an amount, which is the honest answer —
 * the UI then shows the entry as awaiting sync with no figure.
 */

const TYPE_KEYWORDS = [
  // Checked in order; first match wins, so put the specific words first.
  { type: 'credit', words: ['on credit', 'credit', 'deni', 'mkopo', 'owes', 'anadai', 'kwa deni'] },
  { type: 'purchase', words: ['bought', 'buy', 'stock', 'restock', 'supplier', 'nilinunua', 'kununua', 'nunua'] },
  { type: 'expense', words: ['paid', 'expense', 'rent', 'kodi', 'transport', 'fare', 'nililipa', 'malipo', 'salary', 'mshahara', 'electricity', 'stima', 'water', 'maji'] },
  { type: 'sale', words: ['sold', 'sale', 'sell', 'niliuza', 'nimeuza', 'kuuza', 'uza', 'mauzo'] },
];

const NUMBER_WORDS = {
  one: 1, moja: 1,
  two: 2, mbili: 2,
  three: 3, tatu: 3,
  four: 4, nne: 4,
  five: 5, tano: 5,
  six: 6, sita: 6,
  seven: 7, saba: 7,
  eight: 8, nane: 8,
  nine: 9, tisa: 9,
  ten: 10, kumi: 10,
  twenty: 20, ishirini: 20,
  thirty: 30, thelathini: 30,
  forty: 40, arobaini: 40,
  fifty: 50, hamsini: 50,
  hundred: 100, mia: 100,
  thousand: 1000, elfu: 1000,
};

// Words that are never part of an item name.
const NOISE = new Set([
  'i', 'we', 'a', 'an', 'the', 'at', 'for', 'each', 'of', 'to', 'and', 'ya', 'za', 'kwa', 'ni',
  'total', 'shillings', 'shilling', 'ksh', 'kes', 'bob', 'shs', 'x', 'by', 'per', 'today', 'leo',
]);

const round2 = (n) => Math.round(n * 100) / 100;

function detectType(lower) {
  for (const { type, words } of TYPE_KEYWORDS) {
    if (words.some((word) => lower.includes(word))) return type;
  }
  return 'sale'; // a duka logs sales far more often than anything else
}

function extractNumbers(lower) {
  const numbers = [];
  // Digits first, including "1,200" and "12.50"
  const digitRe = /\d[\d,]*(?:\.\d+)?/g;
  let match;
  while ((match = digitRe.exec(lower)) !== null) {
    const parsed = Number(match[0].replace(/,/g, ''));
    if (Number.isFinite(parsed)) numbers.push({ value: parsed, index: match.index });
  }
  if (numbers.length) return numbers;

  // Fall back to spelled-out numbers ("sold five mandazi at ten")
  for (const [word, val] of Object.entries(NUMBER_WORDS)) {
    const wordRe = new RegExp(`\\b${word}\\b`, 'g');
    while ((match = wordRe.exec(lower)) !== null) {
      numbers.push({ value: val, index: match.index });
    }
  }
  return numbers.sort((a, b) => a.index - b.index);
}

function guessItem(text, lower) {
  const skipWords = new Set(TYPE_KEYWORDS.flatMap((k) => k.words.flatMap((w) => w.split(' '))));
  const candidates = text
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean)
    .filter((word) => !/\d/.test(word))
    .filter((word) => {
      const w = word.toLowerCase();
      return !NOISE.has(w) && !(w in NUMBER_WORDS);
    });

  const words = candidates.filter((word) => !skipWords.has(word.toLowerCase()));
  if (words.length) return words.slice(0, 4).join(' ');

  // Every remaining word was a type keyword ("rent 15000", "paid 500 for
  // transport") — that keyword *is* the best name we have for the item.
  if (candidates.length) return candidates.slice(0, 4).join(' ');

  return detectType(lower) === 'sale' ? 'Sale' : 'Transaction';
}

/**
 * @param {string} text
 * @returns {{type: string, item: string, qty: number, unit_price: number,
 *            total: number, transcription: string} | null}
 */
export function parseTransactionLocally(text) {
  if (!text || !text.trim()) return null;

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const numbers = extractNumbers(lower);
  if (!numbers.length) return null;

  const type = detectType(lower);
  const item = guessItem(trimmed, lower);

  let qty;
  let unitPrice;

  if (numbers.length === 1) {
    // "paid 500 for transport" — one figure is the whole amount.
    qty = 1;
    unitPrice = numbers[0].value;
  } else {
    // "sold 10 loaves at 50 each" — quantity then unit price. Explicit totals
    // ("...for 500 total") are handled below.
    qty = numbers[0].value;
    unitPrice = numbers[1].value;
  }

  let total = round2(qty * unitPrice);

  const totalMatch = lower.match(/(?:total|jumla|altogether)\D{0,10}(\d[\d,]*(?:\.\d+)?)/);
  if (totalMatch) {
    total = round2(Number(totalMatch[1].replace(/,/g, '')));
    if (qty > 0) unitPrice = round2(total / qty);
  }

  if (!Number.isFinite(total) || total <= 0) return null;

  return {
    type,
    item,
    qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
    unit_price: Number.isFinite(unitPrice) ? round2(unitPrice) : total,
    total,
    transcription: trimmed,
  };
}
