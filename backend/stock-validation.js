/**
 * Guard rails for stock line items — whether Gemini extracted them from a
 * receipt photo or the owner typed them in by hand.
 *
 * Phone photos are often blurry, cropped, or half a till slip, so we never
 * trust a total that does not add up. Invalid lines are rejected before
 * anything is written to Mongo, which is what keeps weekly report figures
 * from being poisoned by a bad parse.
 */

/** One shilling of slack: qty × unit_cost is often rounded on paper receipts. */
export const TOTAL_TOLERANCE_KES = 1;

export const roundMoney = (value) => Math.round(Number(value) * 100) / 100;

/**
 * Gemini (and owners) send numbers as "1,200", "KSh 80", or actual numbers.
 * Anything we cannot turn into a finite number is treated as missing.
 */
export function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/ksh|kes|shs/gi, '').replace(/[/ =,]/g, '').trim();
    if (!cleaned) return NaN;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function cleanItemName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Validate a single stock line.
 *
 * Missing total is filled in from qty × unit_cost. Missing unit_cost is
 * filled in from total / qty. A supplied total that disagrees with the
 * product by more than TOTAL_TOLERANCE_KES is rejected — that is the
 * "invalid totals rejected" rule the tests lock down.
 *
 * @returns {{ ok: true, item: object } | { ok: false, error: string }}
 */
export function validateStockItem(raw) {
  const item = cleanItemName(raw?.item);
  if (!item) {
    return { ok: false, error: 'Item name is required' };
  }

  const qty = coerceNumber(raw?.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, error: `Quantity for "${item || 'item'}" must be a number greater than 0` };
  }

  let unitCost = coerceNumber(raw?.unit_cost ?? raw?.unit_price);
  let total = coerceNumber(raw?.total);

  if (Number.isFinite(unitCost) && unitCost < 0) {
    return { ok: false, error: `Unit cost for "${item}" cannot be negative` };
  }
  if (Number.isFinite(total) && total < 0) {
    return { ok: false, error: `Total for "${item}" cannot be negative` };
  }

  const hasCost = Number.isFinite(unitCost);
  const hasTotal = Number.isFinite(total);

  if (!hasCost && !hasTotal) {
    return { ok: false, error: `Could not determine a cost for "${item}"` };
  }

  if (!hasCost) {
    unitCost = roundMoney(total / qty);
  }

  if (!hasTotal) {
    total = roundMoney(qty * unitCost);
  }

  if (unitCost < 0) {
    return { ok: false, error: `Unit cost for "${item}" cannot be negative` };
  }

  const expected = qty * unitCost;
  if (Math.abs(expected - total) > TOTAL_TOLERANCE_KES) {
    return {
      ok: false,
      error: `Total for "${item}" (KSh ${roundMoney(total)}) does not match ${qty} × KSh ${roundMoney(unitCost)}`
    };
  }

  let pieces = coerceNumber(raw?.pieces_per_pack);
  if (!Number.isFinite(pieces) || pieces <= 0) pieces = 1;
  if (pieces > 10000) {
    return { ok: false, error: `Pieces per pack for "${item}" is too large` };
  }

  return {
    ok: true,
    item: {
      item,
      qty,
      unit_cost: roundMoney(unitCost),
      pieces_per_pack: roundMoney(pieces),
      total: roundMoney(total)
    }
  };
}

/**
 * Walk Gemini's receipt JSON and keep only lines that pass the guards.
 * Rejected lines come back as warnings so the owner can type them in
 * instead of us silently inventing numbers.
 *
 * @returns {{ ok: true, supplier: string, date: string|null, items: object[], rejected: object[] }
 *         | { ok: false, error: string, rejected?: object[] }}
 */
export function sanitizeReceiptParse(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Could not read any line items from this receipt' };
  }

  if (parsed.error) {
    return { ok: false, error: String(parsed.error) };
  }

  const rawLines = Array.isArray(parsed.line_items)
    ? parsed.line_items
    : Array.isArray(parsed.items)
      ? parsed.items
      : [];

  if (!rawLines.length) {
    return { ok: false, error: 'No line items found on this receipt. Try a clearer photo or enter the stock by hand.' };
  }

  const items = [];
  const rejected = [];

  for (const raw of rawLines) {
    const result = validateStockItem(raw);
    if (result.ok) {
      items.push(result.item);
    } else {
      rejected.push({
        item: cleanItemName(raw?.item) || null,
        reason: result.error
      });
    }
  }

  if (!items.length) {
    return {
      ok: false,
      error: 'Every line on this receipt had an invalid total or missing cost. Correct it by hand, or try a clearer photo.',
      rejected
    };
  }

  const supplier = cleanItemName(parsed.supplier);
  const date = formatDateInput(parseReceiptDate(parsed.date));

  return { ok: true, supplier, date, items, rejected };
}

/**
 * Confirm-step payload: the owner has already edited the rows, so a single
 * invalid line fails the whole batch. Nothing is saved until every row adds up.
 */
export function validateStockBatch(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: 'Add at least one stock item before saving' };
  }

  const items = [];
  for (const raw of rawItems) {
    const result = validateStockItem(raw);
    if (!result.ok) {
      return result;
    }
    items.push(result.item);
  }

  return { ok: true, items };
}

function parseReceiptDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed > new Date() ? new Date() : parsed;
}

/** Value that a `<input type="date">` can show without a UTC day-shift. */
function formatDateInput(date) {
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
