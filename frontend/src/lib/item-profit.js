/**
 * Sold-vs-bought margin on the Daily Ledger.
 * Same Kenyan aliases as the backend: ugali ↔ maize flour, nyama ↔ meat.
 */

const FAMILIES = {
  ugali: ['ugali', 'unga', 'posho', 'sembe', 'maize flour', 'maize meal'],
  nyama: ['nyama', 'meat', 'beef', 'goat', 'mbuzi'],
  chicken: ['kuku', 'chicken'],
  sukuma: ['sukuma', 'sukuma wiki', 'kale'],
  bread: ['bread', 'loaf', 'loaves', 'mkate'],
  milk: ['milk', 'maziwa'],
  sugar: ['sugar', 'sukari'],
  oil: ['oil', 'cooking oil', 'mafuta'],
  rice: ['rice', 'mchele'],
  chapati: ['chapati', 'chapatti'],
  soap: ['soap', 'sabuni']
};

const normalize = (name) => String(name || '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function familyOf(name) {
  const key = normalize(name);
  if (!key) return '';
  for (const [family, aliases] of Object.entries(FAMILIES)) {
    if (aliases.some((alias) => key === alias || key.includes(alias) || (key.length >= 3 && alias.includes(key)))) {
      return family;
    }
  }
  return key;
}

function averageCost(lots) {
  let cost = 0;
  let qty = 0;
  for (const lot of lots || []) {
    const q = Number(lot.qty) || 0;
    const u = Number(lot.unit_cost);
    if (q <= 0 || !Number.isFinite(u) || u < 0) continue;
    cost += q * u;
    qty += q;
  }
  return qty > 0 ? cost / qty : null;
}

export function resolveUnitCost(itemName, stockLots) {
  const key = normalize(itemName);
  if (!key || !stockLots?.length) return null;
  const family = familyOf(itemName);
  const matched = stockLots.filter((lot) => familyOf(lot.item) === family);
  if (matched.length) return averageCost(matched);
  const fuzzy = stockLots.filter((lot) => {
    const lotKey = normalize(lot.item);
    if (!lotKey) return false;
    const shorter = lotKey.length <= key.length ? lotKey : key;
    const longer = lotKey.length <= key.length ? key : lotKey;
    return shorter.length >= 3 && longer.includes(shorter);
  });
  return fuzzy.length ? averageCost(fuzzy) : null;
}

export function attachSaleProfits(soldRows, stockLots) {
  return (soldRows || []).map((row) => {
    const unit_cost = resolveUnitCost(row.item, stockLots);
    if (unit_cost == null) {
      return { ...row, cost_unknown: true, unit_cost: null, gross_profit: null };
    }
    const cogs = row.qty * unit_cost;
    const gross_profit = row.total - cogs;
    return {
      ...row,
      cost_unknown: false,
      unit_cost,
      cogs,
      gross_profit,
      margin: row.total > 0 ? (gross_profit / row.total) * 100 : null
    };
  });
}
