/** Shared display helpers for amounts and "when did this happen" labels. */

export const formatKsh = (amount) =>
  `KSh ${Number(amount || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;

/** "30%" — returns an em dash when margin is unknown (no stock cost yet). */
export const formatPercent = (value) =>
  Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : '—';

/** Short relative time, e.g. "just now", "4 min ago", "yesterday 18:40". */
export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 21600) return `${Math.round(seconds / 3600)} hr ago`;

  const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (then >= startOfToday) return time;

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (then >= startOfYesterday) return `yesterday ${time}`;

  return `${then.toLocaleDateString()} ${time}`;
}

export const formatDuration = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
};
