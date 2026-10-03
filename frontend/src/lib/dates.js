/** Kenya-calendar helpers shared by the ledger filter and the till slip. */

export function todayKenya() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
}

export function kenyaDayOf(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
}

export function formatKenyaDate(yyyyMmDd) {
  const stamp = new Date(`${yyyyMmDd}T12:00:00+03:00`);
  if (Number.isNaN(stamp.getTime())) return yyyyMmDd || '';
  return stamp.toLocaleDateString('en-KE', {
    timeZone: 'Africa/Nairobi',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

export function entriesOnKenyaDate(entries, yyyyMmDd) {
  return (Array.isArray(entries) ? entries : []).filter(
    (entry) => kenyaDayOf(entry.timestamp) === yyyyMmDd
  );
}

export function groupByItem(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const label = String(row.item || 'Item').trim() || 'Item';
    const key = label.toLowerCase();
    const existing = groups.get(key) || { item: label, qty: 0, total: 0 };
    existing.qty += Number(row.qty) || 0;
    existing.total += Number(row.total) || 0;
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      item: group.item,
      qty: group.qty,
      total: group.total,
      unit_price: group.qty > 0 ? group.total / group.qty : group.total
    }))
    .sort((a, b) => b.total - a.total);
}
