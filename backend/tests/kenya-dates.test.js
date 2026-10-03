import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterEntriesByKenyaRange,
  formatKenyaPeriod,
  kenyaDateString,
  kenyaWeekRange
} from '../kenya-dates.js';

test('formats a single day and a week span in Kenya English', () => {
  assert.equal(formatKenyaPeriod('2026-10-03', '2026-10-03'), '3 Oct 2026');
  assert.match(formatKenyaPeriod('2026-09-27', '2026-10-03'), /27 Sep/);
  assert.match(formatKenyaPeriod('2026-09-27', '2026-10-03'), /3 Oct 2026/);
});

test('weekly range is seven Kenya days ending today', () => {
  const { start, end } = kenyaWeekRange(new Date('2026-10-03T18:00:00+03:00'));
  assert.equal(end, '2026-10-03');
  assert.equal(start, '2026-09-27');
});

test('filters ledger rows to the chosen Kenya day', () => {
  const rows = [
    { item: 'Sugar', timestamp: '2026-10-03T08:00:00+03:00' },
    { item: 'Oil', timestamp: '2026-10-02T22:00:00+03:00' }
  ];
  const day = filterEntriesByKenyaRange(rows, '2026-10-03', '2026-10-03');
  assert.deepEqual(day.map((row) => row.item), ['Sugar']);
  assert.equal(kenyaDateString('2026-10-02T22:30:00+03:00'), '2026-10-02');
});
