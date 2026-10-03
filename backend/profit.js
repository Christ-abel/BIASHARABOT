/**
 * Item-level gross profit from recorded stock costs.
 *
 * Two different "profit" numbers live on the weekly report on purpose:
 *
 *   - net_profit is cash-basis and does not change: revenue − purchases −
 *     expenses − M-Pesa fees. That is what the SMS already sent last week.
 *   - gross_profit is accrual-style: for each item sold, COGS is
 *     qty_sold × the weighted-average unit cost of stock purchases of that
 *     item. Margin is gross / revenue for the items we actually have a cost
 *     for. Sales with no matching stock lot are listed, not guessed.
 *
 * Stock-on-hand (qty remaining after sales) is out of scope — we only use
 * purchase costs, we do not decrement lots.
 */

import { itemFamily, normalizeItemName } from './item-names.js';
import { roundMoney } from './stock-validation.js';

export { normalizeItemName, itemFamily } from './item-names.js';

/** Shortest token we will use for a fuzzy item-name match. "oil" is fine; "a" is not. */
const FUZZY_MIN_LENGTH = 3;

function piecesPerPack(lot) {
  const pieces = Number(lot?.pieces_per_pack);
  return Number.isFinite(pieces) && pieces > 0 ? pieces : 1;
}

/**
 * Cost of one *sold* piece. A bar bought at 80 that becomes 4 pieces
 * costs 20 each. Weighting is by sale pieces, not by wholesale packs.
 */
function weightedSaleUnitCost(lots) {
  let money = 0;
  let salePieces = 0;
  let packCostSum = 0;
  let packQty = 0;
  let piecesHint = 1;
  let stockItem = '';
  for (const lot of lots) {
    const packs = Number(lot.qty) || 0;
    const packCost = Number(lot.unit_cost);
    const pieces = piecesPerPack(lot);
    if (packs <= 0 || !Number.isFinite(packCost) || packCost < 0) continue;
    money += packs * packCost;
    salePieces += packs * pieces;
    packCostSum += packs * packCost;
    packQty += packs;
    piecesHint = pieces;
    stockItem = lot.item || stockItem;
  }
  if (salePieces <= 0) return null;
  return {
    unit_cost: roundMoney(money / salePieces),
    pack_cost: packQty > 0 ? roundMoney(packCostSum / packQty) : null,
    pieces_per_pack: piecesHint,
    stock_item: stockItem
  };
}

/**
 * Resolve a unit cost for a sold item against recorded stock lots.
 * Exact / family name wins; "soap" matches "Bar Soap". Cost is per
 * piece the owner sells, not per wholesale pack.
 */
export function resolveSaleCost(itemName, stockLots) {
  const key = normalizeItemName(itemName);
  if (!key || !Array.isArray(stockLots) || !stockLots.length) return null;

  const family = itemFamily(itemName);
  const familyMatch = stockLots.filter((lot) => itemFamily(lot.item) === family);
  if (familyMatch.length) return weightedSaleUnitCost(familyMatch);

  const fuzzy = stockLots.filter((lot) => {
    const lotKey = normalizeItemName(lot.item);
    if (!lotKey) return false;
    const shorter = lotKey.length <= key.length ? lotKey : key;
    const longer = lotKey.length <= key.length ? key : lotKey;
    return shorter.length >= FUZZY_MIN_LENGTH && longer.includes(shorter);
  });

  return fuzzy.length ? weightedSaleUnitCost(fuzzy) : null;
}

export function resolveUnitCost(itemName, stockLots) {
  const resolved = resolveSaleCost(itemName, stockLots);
  return resolved ? resolved.unit_cost : null;
}

function sumBy(entries, predicate) {
  return entries
    .filter(predicate)
    .reduce((sum, entry) => sum + (Number(entry.total) || 0), 0);
}

/**
 * Group sales by normalized item name, then attach stock-based COGS.
 * Items with no matching stock lot are returned with cost_unknown: true so
 * the till slip can say so instead of pretending the goods were free.
 */
export function computeItemProfits(sales, stockLots) {
  const groups = new Map();

  for (const sale of sales) {
    const label = String(sale.item || 'Sale').trim() || 'Sale';
    const key = normalizeItemName(label) || 'sale';
    const existing = groups.get(key) || {
      item: label,
      qty_sold: 0,
      revenue: 0
    };
    existing.qty_sold += Number(sale.qty) || 0;
    existing.revenue += Number(sale.total) || 0;
    groups.set(key, existing);
  }

  const rows = [];
  for (const group of groups.values()) {
    const resolved = resolveSaleCost(group.item, stockLots);
    const revenue = roundMoney(group.revenue);
    const qtySold = group.qty_sold;
    const unit_price = qtySold > 0 ? roundMoney(revenue / qtySold) : revenue;

    if (!resolved) {
      rows.push({
        item: group.item,
        qty_sold: qtySold,
        unit_price,
        revenue,
        unit_cost: null,
        pack_cost: null,
        pieces_per_pack: null,
        stock_item: null,
        cogs: null,
        gross_profit: null,
        margin: null,
        cost_unknown: true
      });
      continue;
    }

    const unitCost = resolved.unit_cost;
    const cogs = roundMoney(qtySold * unitCost);
    const grossProfit = roundMoney(revenue - cogs);
    const margin = revenue > 0 ? roundMoney((grossProfit / revenue) * 100) : null;

    rows.push({
      item: group.item,
      qty_sold: qtySold,
      unit_price,
      revenue,
      unit_cost: unitCost,
      pack_cost: resolved.pack_cost,
      pieces_per_pack: resolved.pieces_per_pack,
      stock_item: resolved.stock_item,
      cogs,
      gross_profit: grossProfit,
      margin,
      cost_unknown: false
    });
  }

  rows.sort((a, b) => b.revenue - a.revenue);
  return rows;
}

/** Receipt lines: one row per product sold, with qty, unit price and total. */
export function groupSoldProducts(sales = []) {
  const groups = new Map();
  for (const sale of Array.isArray(sales) ? sales : []) {
    const label = String(sale.item || 'Sale').trim() || 'Sale';
    const key = normalizeItemName(label) || 'sale';
    const existing = groups.get(key) || { item: label, qty: 0, total: 0 };
    existing.qty += Number(sale.qty) || 0;
    existing.total += Number(sale.total) || 0;
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      item: group.item,
      qty: group.qty,
      total: roundMoney(group.total),
      unit_price: group.qty > 0 ? roundMoney(group.total / group.qty) : roundMoney(group.total)
    }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Full weekly report object. Cash-basis fields keep the same formula the
 * dashboard and SMS have always used; the new fields sit beside them.
 */
export function buildWeeklyReport(entries = [], stockLots = []) {
  const list = Array.isArray(entries) ? entries : [];
  const lots = Array.isArray(stockLots) ? stockLots : [];

  const revenue = sumBy(list, (e) => e.type === 'sale');
  const cost_of_goods = sumBy(list, (e) => e.type === 'purchase');
  const other_expenses = sumBy(list, (e) => e.type === 'expense' && e.source !== 'payhero');
  const mpesa_fees = sumBy(list, (e) => e.type === 'expense' && e.source === 'payhero');
  const outstanding_credit = sumBy(list, (e) => e.type === 'credit' && !e.matched);
  const net_profit = revenue - cost_of_goods - other_expenses - mpesa_fees;

  const sales = list.filter((e) => e.type === 'sale');
  const sold_items = groupSoldProducts(sales);
  const item_profits = computeItemProfits(sales, lots);

  const priced = item_profits.filter((row) => !row.cost_unknown);
  const pricedRevenue = priced.reduce((sum, row) => sum + row.revenue, 0);
  const item_cogs = priced.reduce((sum, row) => sum + (Number(row.cogs) || 0), 0);
  const gross_profit = priced.reduce((sum, row) => sum + (Number(row.gross_profit) || 0), 0);
  const unpriced_revenue = item_profits
    .filter((row) => row.cost_unknown)
    .reduce((sum, row) => sum + row.revenue, 0);

  return {
    revenue,
    cost_of_goods,
    other_expenses,
    mpesa_fees,
    net_profit,
    outstanding_credit,
    sold_items,
    item_profits,
    item_cogs: roundMoney(item_cogs),
    gross_profit: roundMoney(gross_profit),
    gross_margin: pricedRevenue > 0 ? roundMoney((gross_profit / pricedRevenue) * 100) : null,
    items_missing_cost: item_profits.filter((row) => row.cost_unknown).length,
    unpriced_revenue: roundMoney(unpriced_revenue)
  };
}

/**
 * Compact SMS addendum. A weekly till slip already fills most of an SMS;
 * we only add overall gross profit plus the top priced items.
 */
export function formatItemProfitSms(report, limit = 4) {
  if (!report || typeof report.gross_profit !== 'number') return '';

  const marginBit = Number.isFinite(report.gross_margin)
    ? ` (${report.gross_margin.toFixed(0)}%)`
    : '';

  const lines = [`Gross Profit: KSh ${report.gross_profit.toFixed(2)}${marginBit}`];

  const priced = (report.item_profits || []).filter((row) => !row.cost_unknown);
  for (const row of priced.slice(0, limit)) {
    const rowMargin = Number.isFinite(row.margin) ? ` (${row.margin.toFixed(0)}%)` : '';
    lines.push(`  ${row.item}: KSh ${Number(row.gross_profit).toFixed(0)}${rowMargin}`);
  }

  if (report.items_missing_cost > 0) {
    lines.push(`  ${report.items_missing_cost} sold item(s) have no stock cost yet`);
  }

  return lines.join('\n');
}
