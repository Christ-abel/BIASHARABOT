/**
 * Kenyan duka names: what the owner says when selling vs what is printed
 * on a supplier receipt. Matching "ugali" to "Maize Flour 2kg" is how
 * sold-vs-bought profit can show a real margin.
 */

export function normalizeItemName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Each family is one product. Any alias on a sale can match any alias on a stock lot. */
export const ITEM_FAMILIES = {
  ugali: ['ugali', 'unga', 'posho', 'sembe', 'maize flour', 'maize meal', 'unga wa mahindi'],
  nyama: ['nyama', 'meat', 'beef', 'goat', 'mbuzi', 'nyama choma'],
  chicken: ['kuku', 'chicken', 'broiler'],
  fish: ['samaki', 'fish'],
  sukuma: ['sukuma', 'sukuma wiki', 'kale'],
  cabbage: ['cabbage', 'kabichi'],
  tomato: ['tomato', 'tomatoes', 'nyanya'],
  onion: ['onion', 'onions', 'kitunguu'],
  potato: ['potato', 'potatoes', 'viazi'],
  beans: ['beans', 'maharagwe', 'ndengu', 'green grams'],
  rice: ['rice', 'mchele'],
  chapati: ['chapati', 'chapatti'],
  mandazi: ['mandazi', 'mahamri'],
  bread: ['bread', 'loaf', 'loaves', 'mkate'],
  milk: ['milk', 'maziwa', 'milk packet', 'milk packets'],
  eggs: ['eggs', 'egg', 'mayai'],
  sugar: ['sugar', 'sukari'],
  salt: ['salt', 'chumvi'],
  tea: ['tea', 'chai', 'tea leaves'],
  oil: ['oil', 'cooking oil', 'mafuta', 'fat'],
  soap: ['soap', 'bar soap', 'sabuni'],
  soda: ['soda', 'coke', 'fanta', 'sprite', 'soft drink'],
  water: ['water', 'maji', 'drinking water'],
  maize: ['maize', 'mahindi']
};

const ALIAS_TO_FAMILY = (() => {
  const map = new Map();
  for (const [family, aliases] of Object.entries(ITEM_FAMILIES)) {
    for (const alias of aliases) {
      map.set(alias, family);
    }
  }
  return map;
})();

/**
 * Stable family key for matching. Unknown names fall back to the
 * normalized string so "Sugar 2kg" still matches "sugar".
 */
export function itemFamily(name) {
  const key = normalizeItemName(name);
  if (!key) return '';

  const exact = ALIAS_TO_FAMILY.get(key);
  if (exact) return exact;

  let best = '';
  for (const [alias] of ALIAS_TO_FAMILY) {
    if (alias.length < 3) continue;
    const contains = key.includes(alias) || (key.length >= 3 && alias.includes(key));
    if (contains && alias.length > best.length) best = alias;
  }
  if (best) return ALIAS_TO_FAMILY.get(best);

  return key;
}
