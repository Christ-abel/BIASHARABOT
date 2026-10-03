/**
 * Sold-vs-bought margin on the Daily Ledger.
 * Same Kenyan aliases as the backend: ugali ↔ maize flour, soap piece ↔ bar.
 * Cost is per piece sold: a bar at 80 that becomes 4 pieces costs 20 each.
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
  soap: ['soap', 'bar soap', 'sabuni', 'kipande'],
  cup: ['kikombe', 'cup', 'cups'],
  tea: ['tea', 'chai']
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

function piecesOf(lot) {
  const pieces = Number(lot?.pieces_per_pack);
  return Number.isFinite(pieces) && pieces > 0 ? pieces : 1;
}

function averageSaleCost(lots) {
  let money = 0;
  let salePieces = 0;
  let packCost = 0;
  let packQty = 0;
  let pieces = 1;
  for (const lot of lots || []) {
    const packs = Number(lot.qty) || 0;
    const unit = Number(lot.unit_cost);
    const perPack = piecesOf(lot);
    if (packs <= 0 || !Number.isFinite(unit) || unit < 0) continue;
    money += packs * unit;
    salePieces += packs * perPack;
    packCost += packs * unit;
    packQty += packs;
    pieces = perPack;
  }
  if (salePieces <= 0) return null;
  return {
    unit_cost: money / salePieces,
    pack_cost: packQty > 0 ? packCost / packQty : null,
    pieces_per_pack: pieces
  };
}

function matchLots(itemName, stockLots) {
  const key = normalize(itemName);
  if (!key || !stockLots?.length) return [];
  const family = familyOf(itemName);
  const matched = stockLots.filter((lot) => familyOf(lot.item) === family);
  if (matched.length) return matched;
  return stockLots.filter((lot) => {
    const lotKey = normalize(lot.item);
    if (!lotKey) return false;
    const shorter = lotKey.length <= key.length ? lotKey : key;
    const longer = lotKey.length <= key.length ? key : lotKey;
    return shorter.length >= 3 && longer.includes(shorter);
  });
}

export function resolveUnitCost(itemName, stockLots) {
  const resolved = averageSaleCost(matchLots(itemName, stockLots));
  return resolved ? resolved.unit_cost : null;
}

export function attachSaleProfits(soldRows, stockLots) {
  return (soldRows || []).map((row) => {
    const resolved = averageSaleCost(matchLots(row.item, stockLots));
    if (!resolved) {
      return { ...row, cost_unknown: true, unit_cost: null, gross_profit: null };
    }
    const cogs = row.qty * resolved.unit_cost;
    const gross_profit = row.total - cogs;
    return {
      ...row,
      cost_unknown: false,
      unit_cost: resolved.unit_cost,
      pack_cost: resolved.pack_cost,
      pieces_per_pack: resolved.pieces_per_pack,
      cogs,
      gross_profit,
      margin: row.total > 0 ? (gross_profit / row.total) * 100 : null
    };
  });
}
