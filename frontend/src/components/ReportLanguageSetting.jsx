import { useEffect, useState } from 'react';
import { API_BASE } from '../lib/api.js';
import { DEFAULT_LANGUAGE, DEFAULT_LANGUAGES } from '../lib/reportLabels.js';

/**
 * Settings card for the language the weekly report comes in — the till slip
 * on this screen and the SMS alike. Saving needs network: the choice lives on
 * the server because the SMS is generated there.
 */
export default function ReportLanguageSetting({ value, onChange, online, saving }) {
  const [languages, setLanguages] = useState(DEFAULT_LANGUAGES);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/reports/languages`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data?.languages) && data.languages.length) {
          setLanguages(data.languages);
        }
      })
      .catch(() => {
        // Offline or old backend: the built-in list is good enough.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const disabled = saving || !online;
  const hint = !online
    ? 'Changing the report language needs network.'
    : saving
      ? 'Saving and regenerating the report…'
      : 'Applies to the till slip below and to the weekly SMS.';

  return (
    <div className="settings-card">
      <div className="form-group settings-field">
        <label htmlFor="report-language">Report language</label>
        <select
          id="report-language"
          className="form-input"
          value={value || DEFAULT_LANGUAGE}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        >
          {languages.map((language) => (
            <option key={language.code} value={language.code}>
              {language.name}
            </option>
          ))}
        </select>
        <p className="settings-hint">{hint}</p>
      </div>
    </div>
  );
}
