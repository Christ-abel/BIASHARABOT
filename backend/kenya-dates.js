/** Calendar helpers in Kenya time (UTC+3). Weekly figures follow these days. */

export function kenyaDateString(value = new Date()) {
  return new Date(value).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
}

export function kenyaDayBounds(yyyyMmDd) {
  const day = String(yyyyMmDd || kenyaDateString());
  return {
    start: new Date(`${day}T00:00:00+03:00`),
    end: new Date(`${day}T23:59:59.999+03:00`)
  };
}

export function shiftKenyaDate(yyyyMmDd, days) {
  const stamp = new Date(`${yyyyMmDd}T12:00:00+03:00`);
  stamp.setTime(stamp.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
  return kenyaDateString(stamp);
}

export function kenyaWeekRange(asOf = new Date()) {
  const end = kenyaDateString(asOf);
  const start = shiftKenyaDate(end, -6);
  return { start, end };
}

export function formatKenyaDate(yyyyMmDd) {
  const day = String(yyyyMmDd || '');
  const stamp = new Date(`${day}T12:00:00+03:00`);
  if (Number.isNaN(stamp.getTime())) return day;
  return stamp.toLocaleDateString('en-KE', {
    timeZone: 'Africa/Nairobi',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

export function formatKenyaPeriod(start, end) {
  if (!start && !end) return '';
  if (start && end && start === end) return formatKenyaDate(start);
  if (start && end) return `${formatKenyaDate(start)} – ${formatKenyaDate(end)}`;
  return formatKenyaDate(start || end);
}

export function inKenyaRange(value, startDay, endDay) {
  const day = kenyaDateString(value);
  return day >= startDay && day <= endDay;
}

export function filterEntriesByKenyaRange(entries, startDay, endDay) {
  const list = Array.isArray(entries) ? entries : [];
  if (!startDay || !endDay) return list;
  return list.filter((entry) => inKenyaRange(entry.timestamp, startDay, endDay));
}
