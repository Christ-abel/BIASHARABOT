/**
 * On-device fallback parser for transactions typed while offline.
 *
 * Gemini does the real parsing on the server. Offline we still want the duka
 * owner to see a number instead of "pending", so this reads Kenyan shop talk
 * the same way the backend does: "Ugali twenty bob, nyama thirty bob".
 */

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

const TYPE_KEYWORDS = [
  { type: 'credit', words: ['on credit', 'credit', 'deni', 'mkopo', 'owes', 'anadai', 'kwa deni'] },
  { type: 'purchase', words: ['bought', 'buy', 'stock', 'restock', 'supplier', 'nilinunua', 'kununua', 'nunua'] },
  { type: 'expense', words: ['paid', 'expense', 'rent', 'kodi', 'transport', 'fare', 'nililipa', 'malipo', 'salary', 'mshahara', 'electricity', 'stima'] },
  { type: 'sale', words: ['sold', 'sale', 'sell', 'niliuza', 'nimeuza', 'kuuza', 'uza', 'mauzo'] },
];

const SKIP = new Set([
  'i', 'we', 'a', 'an', 'the', 'at', 'for', 'each', 'of', 'to', 'and', 'na', 'ya', 'za',
  'kwa', 'ni', 'total', 'jumla', 'shillings', 'shilling', 'ksh', 'kes', 'bob', 'bobs',
  'shs', 'x', 'by', 'per', 'today', 'leo',
]);

const TYPE_SKIP = new Set(
  TYPE_KEYWORDS.flatMap((row) => row.words.flatMap((word) => word.split(' ')))
);

const PACK_SIZE = /^\d+(?:\.\d+)?(?:kg|g|l|ml|ltr|litre|litres|pkt|pcs|pc)$/i;
const DIGITS = /^\d+(?:\.\d+)?$/;

const round2 = (n) => Math.round(n * 100) / 100;

function detectType(lower) {
  for (const { type, words } of TYPE_KEYWORDS) {
    if (words.some((word) => lower.includes(word))) return type;
  }
  return 'sale';
}

function parseNumberToken(raw) {
  const token = String(raw || '').toLowerCase().replace(/,/g, '');
  if (PACK_SIZE.test(token)) return null;
  if (DIGITS.test(token)) return Number(token);
  if (token in NUMBER_WORDS) return NUMBER_WORDS[token];
  return null;
}

function titleCase(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (PACK_SIZE.test(word) ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ') || 'Sale';
}

export function parseTransactionsLocally(text) {
  if (!text || !text.trim()) return [];
  const trimmed = text.trim();
  const type = detectType(trimmed.toLowerCase());
  const tokens = trimmed.replace(/[;/|]+/g, ' , ').split(/(\s+|,)/).map((part) => part.trim()).filter((part) => part && part !== ',');
  const items = [];
  let nameParts = [];
  let pendingQty = null;

  const flush = (price) => {
    if (!nameParts.length && pendingQty == null) return;
    const qty = Number.isFinite(pendingQty) && pendingQty > 0 ? pendingQty : 1;
    const unit = round2(price);
    if (!Number.isFinite(unit) || unit <= 0) return;
    items.push({
      type,
      item: titleCase(nameParts.join(' ')),
      qty,
      unit_price: unit,
      total: round2(qty * unit),
      transcription: trimmed,
    });
    nameParts = [];
    pendingQty = null;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const raw = tokens[i];
    const lower = raw.toLowerCase();
    if (SKIP.has(lower) || TYPE_SKIP.has(lower)) continue;
    const value = parseNumberToken(lower);
    if (value != null) {
      const next = tokens[i + 1]?.toLowerCase();
      const moneyWord = next === 'bob' || next === 'bobs' || next === 'ksh' || next === 'kes';
      if (!nameParts.length && pendingQty == null) {
        pendingQty = value;
        continue;
      }
      flush(value);
      if (moneyWord) i += 1;
      continue;
    }
    nameParts.push(raw);
  }

  return items;
}

/**
 * @param {string} text
 * @returns {{type: string, item: string, qty: number, unit_price: number,
 *            total: number, transcription: string} | null}
 */
export function parseTransactionLocally(text) {
  const rows = parseTransactionsLocally(text);
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];
  return {
    type: rows[0].type,
    item: rows.map((row) => row.item).join(', '),
    qty: rows.reduce((sum, row) => sum + row.qty, 0),
    unit_price: round2(rows.reduce((sum, row) => sum + row.total, 0) / rows.reduce((sum, row) => sum + row.qty, 0)),
    total: round2(rows.reduce((sum, row) => sum + row.total, 0)),
    transcription: text.trim(),
  };
}
