/**
 * On-device / fallback parser for Kenyan shop talk.
 *
 * Gemini is optional. "Ugali twenty bob, nyama thirty bob" must become two
 * sales even when the API is out of quota. Number words, "bob", pack sizes
 * like 2kg, and Swahili sale verbs are first-class.
 */

import { normalizePhone } from './auth.js';
import { normalizeReportLanguage } from './languages.js';

export const NUMBER_WORDS = {
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
  eleven: 11, kumi_na_moja: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20, ishirini: 20,
  thirty: 30, thelathini: 30,
  forty: 40, arobaini: 40,
  fifty: 50, hamsini: 50,
  sixty: 60, sitini: 60,
  seventy: 70, sabini: 70,
  eighty: 80, themanini: 80,
  ninety: 90, tisini: 90,
  hundred: 100, mia: 100,
  thousand: 1000, elfu: 1000
};

const TYPE_KEYWORDS = [
  { type: 'credit', words: ['on credit', 'credit', 'deni', 'mkopo', 'owes', 'anadai', 'kwa deni', 'kopesha', 'nimekopesha', 'nimemkopesha'] },
  { type: 'purchase', words: ['bought', 'buy', 'stock', 'restock', 'supplier', 'nilinunua', 'kununua', 'nunua', 'nimenunua'] },
  { type: 'expense', words: ['paid', 'expense', 'rent', 'kodi', 'transport', 'fare', 'nililipa', 'malipo', 'salary', 'mshahara', 'electricity', 'stima', 'water bill'] },
  { type: 'sale', words: ['sold', 'sale', 'sell', 'niliuza', 'nimeuza', 'kuuza', 'uza', 'mauzo'] }
];

const SKIP = new Set([
  'i', 'we', 'a', 'an', 'the', 'at', 'for', 'each', 'of', 'to', 'and', 'na', 'ya', 'za',
  'kwa', 'ni', 'total', 'jumla', 'shillings', 'shilling', 'ksh', 'kes', 'bob', 'bobs',
  'shs', 'x', 'by', 'per', 'today', 'leo', 'piece', 'pieces', 'only', 'tu'
]);

const TYPE_SKIP = new Set(
  TYPE_KEYWORDS.flatMap((row) => row.words.flatMap((word) => word.split(' ')))
);

const PACK_SIZE = /^\d+(?:\.\d+)?(?:kg|g|l|ml|ltr|litre|litres|pkt|pcs|pc)$/i;
const DIGITS = /^\d+(?:\.\d+)?$/;
const ENTRY_TYPES = new Set(['sale', 'purchase', 'expense', 'credit']);
const KENYAN_PHONE = /(?:\+?254|0)[\s-]*(?:7|1)(?:[\s-]*\d){8}/g;
const LEND_TWO_WORDS = /\b(?:kopesha|nimekopesha|nimemkopesha)\s+([A-Za-z][A-Za-z']*)\s+([A-Za-z][A-Za-z0-9.]*)/i;
const CREDIT_FOR_NAME = /\b(?:on credit (?:to|for)|credit (?:to|for)|deni (?:ya|kwa)|for)\s+([A-Za-z][A-Za-z']*)\b/i;

const round2 = (n) => Math.round(Number(n) * 100) / 100;

export function detectEntryType(text) {
  const lower = String(text || '').toLowerCase();
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

/** Gemini often hears sukari as yakari, or invents "New Year's curry". */
export function correctShopItemName(name) {
  const raw = String(name || '').trim();
  const key = raw.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(yakari|yahari|yakary|sukary|zakari)$/.test(key)) return 'Sukari';
  if (/new year'?s?\s+curry/.test(key) || key === 'curry') return 'Sukari';
  return raw;
}

function titleCase(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (PACK_SIZE.test(word) ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ') || 'Sale';
}

export function extractKenyanPhone(text) {
  const match = String(text || '').match(KENYAN_PHONE);
  return match ? normalizePhone(match[0]) : '';
}

export function stripKenyanPhones(text) {
  return String(text || '').replace(KENYAN_PHONE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Pull the borrower off a deni line so "kopesha mama sugar 50 0712…"
 * becomes customer Mama + Sugar 50, not an item named Mama Sugar.
 */
export function peelCreditParty(text) {
  const phone = extractKenyanPhone(text);
  let rest = stripKenyanPhones(text);
  let name = '';

  const lend = rest.match(LEND_TWO_WORDS);
  if (lend) {
    name = titleCase(lend[1]);
    rest = rest.replace(new RegExp(`\\b${lend[1]}\\b`, 'i'), ' ');
  } else {
    const named = rest.match(CREDIT_FOR_NAME);
    const maybe = named?.[1]?.toLowerCase();
    if (named && maybe && !SKIP.has(maybe) && !TYPE_SKIP.has(maybe)) {
      name = titleCase(named[1]);
      rest = rest.replace(named[0], ' ');
    }
  }

  return { phone, name, rest: rest.replace(/\s+/g, ' ').trim() };
}

function attachCreditParty(entry, originalText) {
  if (entry.type !== 'credit') return entry;
  const party = peelCreditParty(originalText);
  const phone = normalizePhone(entry.customer_phone || party.phone || '');
  const looksPhone = /^254[17]\d{8}$/.test(phone);
  return {
    ...entry,
    customer_name: String(entry.customer_name || party.name || '').trim(),
    customer_phone: looksPhone ? phone : ''
  };
}

function tokenize(text) {
  return String(text || '')
    .replace(/[;/|]+/g, ' , ')
    .split(/(\s+|,)/)
    .map((part) => part.trim())
    .filter((part) => part && part !== ',');
}

function flushItem(items, nameParts, qty, price, type) {
    const item = correctShopItemName(titleCase(nameParts.join(' ')));
  const unit = round2(price);
  const count = Number.isFinite(qty) && qty > 0 ? qty : 1;
  if (!Number.isFinite(unit) || unit <= 0) return;
  items.push({
    type,
    item,
    qty: count,
    unit_price: unit,
    total: round2(count * unit)
  });
}

/**
 * Split one spoken or typed line into ledger rows.
 * "Ugali twenty bob, nyama thirty bob" → two sales at 20 and 30.
 */
export function parseShopTalk(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  const type = detectEntryType(trimmed);
  const party = type === 'credit' ? peelCreditParty(trimmed) : { phone: '', name: '', rest: trimmed };
  const tokens = tokenize(party.rest || trimmed);
  const items = [];
  let nameParts = [];
  let pendingQty = null;

  const flush = (price) => {
    if (!nameParts.length && pendingQty == null) return;
    flushItem(items, nameParts, pendingQty, price, type);
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
      const nextIsMoneyWord = next === 'bob' || next === 'bobs' || next === 'ksh' || next === 'kes' || next === 'shillings';
      if (!nameParts.length && pendingQty == null) {
        pendingQty = value;
        continue;
      }
      if (nameParts.length && pendingQty != null) {
        flush(value);
        if (nextIsMoneyWord) i += 1;
        continue;
      }
      if (nameParts.length && pendingQty == null) {
        flush(value);
        if (nextIsMoneyWord) i += 1;
        continue;
      }
      pendingQty = value;
      continue;
    }

    if (PACK_SIZE.test(raw) || !SKIP.has(lower)) {
      nameParts.push(raw);
    }
  }

  return type === 'credit'
    ? items.map((row) => attachCreditParty(row, trimmed))
    : items;
}

export function phraseEntry(entry, language) {
  const lang = normalizeReportLanguage(language);
  const item = entry.item || 'Sale';
  const qty = Number(entry.qty) || 1;
  const price = round2(entry.unit_price);
  const type = ENTRY_TYPES.has(entry.type) ? entry.type : 'sale';

  if (lang === 'sw') {
    if (type === 'purchase') {
      return qty === 1
        ? `Nimenunua ${item} kwa KSh ${price}`
        : `Nimenunua ${item} ${qty} kwa KSh ${price} kila moja`;
    }
    if (type === 'expense') return `Gharama: ${item} KSh ${round2(entry.total)}`;
    if (type === 'credit') {
      const who = entry.customer_name ? ` kwa ${entry.customer_name},` : '';
      return `${item} kwa deni${who} KSh ${round2(entry.total)}`;
    }
    return qty === 1
      ? `${item} iliuza kwa KSh ${price}`
      : `Nimeuza ${item} ${qty} kwa KSh ${price} kila moja`;
  }

  if (type === 'purchase') {
    return qty === 1
      ? `Bought ${item} for KSh ${price}`
      : `Bought ${qty} ${item} at KSh ${price} each`;
  }
  if (type === 'expense') return `Expense: ${item} KSh ${round2(entry.total)}`;
  if (type === 'credit') {
    const who = entry.customer_name ? ` for ${entry.customer_name},` : ' for';
    return `${item} on credit${who} KSh ${round2(entry.total)}`;
  }
  return qty === 1
    ? `${item} was sold for KSh ${price}`
    : `Sold ${qty} ${item} at KSh ${price} each`;
}

export function attachPhrases(items, language, spokenText = '') {
  return (items || []).map((row, index) => ({
    ...row,
    transcription: phraseEntry(row, language),
    spoken: spokenText || '',
    line: index + 1
  }));
}

export function coerceParsedEntries(parsed, originalText = '', language = 'en') {
  const rows = [];
  if (Array.isArray(parsed?.items) && parsed.items.length) {
    rows.push(...parsed.items);
  } else if (parsed && parsed.item) {
    rows.push(parsed);
  }

  const cleaned = [];
  for (const row of rows) {
    const type = ENTRY_TYPES.has(row.type) ? row.type : detectEntryType(originalText);
    const qty = Number(row.qty);
    const unit = Number(row.unit_price);
    const total = Number(row.total);
    const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const safeUnit = Number.isFinite(unit) ? unit : (Number.isFinite(total) ? total / safeQty : NaN);
    const safeTotal = Number.isFinite(total) ? total : round2(safeQty * safeUnit);
    if (!Number.isFinite(safeTotal) || safeTotal <= 0 || !Number.isFinite(safeUnit)) continue;
    const item = correctShopItemName(String(row.item || '').trim() || 'Sale');
    const entry = {
      type,
      item,
      qty: safeQty,
      unit_price: round2(safeUnit),
      total: round2(safeTotal)
    };
    const withParty = attachCreditParty({
      ...entry,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone
    }, originalText);
    withParty.transcription = row.transcription && String(row.transcription).trim()
      ? String(row.transcription).trim()
      : phraseEntry(withParty, language);
    cleaned.push(withParty);
  }
  return cleaned;
}
