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

import { roundMoney } from './stock-validation.js';

/** Shortest token we will use for a fuzzy item-name match. "oil" is fine; "a" is not. */
const FUZZY_MIN_LENGTH = 3;

export function normalizeItemName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function weightedAverageCost(lots) {
  let costSum = 0;
  let qtySum = 0;
  for (const lot of lots) {
    const qty = Number(lot.qty) || 0;
    const cost = Number(lot.unit_cost);
    if (qty <= 0 || !Number.isFinite(cost) || cost < 0) continue;
    costSum += qty * cost;
    qtySum += qty;
  }
  if (qtySum <= 0) return null;
  return roundMoney(costSum / qtySum);
}

/**
 * Resolve a unit cost for a sold item against recorded stock lots.
 * Exact normalized name wins; otherwise a contains-match either way
 * ("sugar" ↔ "Sugar 2kg") as long as the shorter name is long enough
 * that we are not matching on a single letter.
 */
export function resolveUnitCost(itemName, stockLots) {
  const key = normalizeItemName(itemName);
  if (!key || !Array.isArray(stockLots) || !stockLots.length) return null;

  const exact = stockLots.filter((lot) => normalizeItemName(lot.item) === key);
  if (exact.length) return weightedAverageCost(exact);

  const fuzzy = stockLots.filter((lot) => {
    const lotKey = normalizeItemName(lot.item);
    if (!lotKey) return false;
    const shorter = lotKey.length <= key.length ? lotKey : key;
    const longer = lotKey.length <= key.length ? key : lotKey;
    return shorter.length >= FUZZY_MIN_LENGTH && longer.includes(shorter);
  });

  return fuzzy.length ? weightedAverageCost(fuzzy) : null;
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
    const unitCost = resolveUnitCost(group.item, stockLots);
    const revenue = roundMoney(group.revenue);
    const qtySold = group.qty_sold;

    if (unitCost === null) {
      rows.push({
        item: group.item,
        qty_sold: qtySold,
        revenue,
        unit_cost: null,
        cogs: null,
        gross_profit: null,
        margin: null,
        cost_unknown: true
      });
      continue;
    }

    const cogs = roundMoney(qtySold * unitCost);
    const grossProfit = roundMoney(revenue - cogs);
    const margin = revenue > 0 ? roundMoney((grossProfit / revenue) * 100) : null;

    rows.push({
      item: group.item,
      qty_sold: qtySold,
      revenue,
      unit_cost: unitCost,
      cogs,
      gross_profit: grossProfit,
      margin,
      cost_unknown: false
    });
  }

  rows.sort((a, b) => b.revenue - a.revenue);
  return rows;
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
