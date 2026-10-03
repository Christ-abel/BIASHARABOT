import React from 'react';
import { formatKenyaDate, todayKenya } from '../lib/dates.js';

export default function DateFilter({ id = 'ledger-date', value, onChange, label = 'Date', allowEmpty = false, emptyLabel = 'This week' }) {
  const today = todayKenya();
  return (
    <div className="date-filter">
      <label htmlFor={id}>{label}</label>
      <div className="date-filter-controls">
        <input
          id={id}
          type="date"
          className="form-input"
          value={value}
          max={today}
          onChange={(event) => onChange(event.target.value)}
        />
        {allowEmpty && (
          <button type="button" className="date-filter-today" onClick={() => onChange('')} disabled={!value}>
            {emptyLabel}
          </button>
        )}
        <button type="button" className="date-filter-today" onClick={() => onChange(today)} disabled={value === today}>
          Today
        </button>
      </div>
      <p className="date-filter-caption">{value ? formatKenyaDate(value) : emptyLabel}</p>
    </div>
  );
}
