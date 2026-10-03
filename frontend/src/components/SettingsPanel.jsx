import React, { useEffect, useState } from 'react';
import { API_BASE, authHeaders } from '../lib/api.js';
import { formatKsh } from '../lib/format.js';

const LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'sw', label: 'Kiswahili' }
];

const STATUS_CLASS = {
  action_needed: 'compliance-status action',
  upcoming: 'compliance-status upcoming',
  overdue: 'compliance-status overdue',
  ok: 'compliance-status ok'
};

function persistOwner(next) {
  localStorage.setItem('biashara_business', JSON.stringify(next));
}

/**
 * Shop settings: report language (Issue 1) and the tax / permit profile
 * plus checklist (Issue 4). Changing language refreshes the cached owner
 * record so the next till slip and SMS pick it up.
 */
export default function SettingsPanel({ business, online, onBusinessChange, onError, onSuccess }) {
  const [language, setLanguage] = useState(business.reportLanguage || 'en');
  const [savingLang, setSavingLang] = useState(false);

  const [profile, setProfile] = useState({
    businessType: business.businessType || 'sole_proprietor',
    county: business.county || '',
    kraPin: business.kraPin || 'unknown',
    estimatedAnnualTurnover: business.estimatedAnnualTurnover || ''
  });
  const [savingProfile, setSavingProfile] = useState(false);

  const [compliance, setCompliance] = useState(null);
  const [loadingCompliance, setLoadingCompliance] = useState(false);

  const labels = compliance?.labels;

  const loadCompliance = async (notify = false) => {
    if (!business) return;
    setLoadingCompliance(true);
    try {
      const query = new URLSearchParams({
        businessId: business.id,
        language: business.reportLanguage || 'en'
      });
      if (notify) query.set('notify', '1');
      const response = await fetch(`${API_BASE}/compliance?${query}`);
      if (!response.ok) throw new Error('Could not load compliance');
      setCompliance(await response.json());
    } catch (err) {
      console.warn('Compliance load failed:', err);
    } finally {
      setLoadingCompliance(false);
    }
  };

  useEffect(() => {
    setLanguage(business.reportLanguage || 'en');
    setProfile({
      businessType: business.businessType || 'sole_proprietor',
      county: business.county || '',
      kraPin: business.kraPin || 'unknown',
      estimatedAnnualTurnover: business.estimatedAnnualTurnover || ''
    });
    loadCompliance(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business?.id, business?.reportLanguage]);

  const patchBusiness = async (body) => {
    const response = await fetch(`${API_BASE}/business/${business.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not update profile');
    }
    persistOwner(data);
    onBusinessChange(data);
    return data;
  };

  const handleLanguage = async (code) => {
    if (code === language) return;
    onError(null);
    onSuccess(null);
    if (!online) {
      onError('Changing report language needs network.');
      return;
    }
    setSavingLang(true);
    try {
      await patchBusiness({ reportLanguage: code });
      setLanguage(code);
      onSuccess(code === 'sw'
        ? 'Ripoti zijazo zitakuwa kwa Kiswahili.'
        : 'The next till slip and SMS will be in English.');
    } catch (err) {
      onError(err.message);
    } finally {
      setSavingLang(false);
    }
  };

  const handleProfile = async (event) => {
    event.preventDefault();
    onError(null);
    onSuccess(null);
    if (!online) {
      onError('Saving your shop profile needs network.');
      return;
    }
    setSavingProfile(true);
    try {
      await patchBusiness({
        businessType: profile.businessType,
        county: profile.county,
        kraPin: profile.kraPin,
        estimatedAnnualTurnover: Number(profile.estimatedAnnualTurnover) || 0
      });
      onSuccess(labels?.saveProfile ? `${labels.saveProfile}.` : 'Shop profile saved.');
      await loadCompliance(true);
    } catch (err) {
      onError(err.message);
    } finally {
      setSavingProfile(false);
    }
  };

  const copy = labels || COMPLIANCE_LABELS_FALLBACK;

  return (
    <div className="settings-panel">
      <div className="logger-card">
        <h3>Report language</h3>
        <p className="stock-lead">
          Weekly till slip and SMS use this language. Amounts stay in KSh either way.
        </p>
        <div className="language-toggle" role="group" aria-label="Report language">
          {LANGUAGE_OPTIONS.map((option) => (
            <button
              key={option.code}
              type="button"
              className={`language-chip ${language === option.code ? 'active' : ''}`}
              onClick={() => handleLanguage(option.code)}
              disabled={savingLang || !online}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <form className="logger-card" onSubmit={handleProfile}>
        <h3>{copy.profileHeading}</h3>
        <p className="stock-lead">{copy.profileHint}</p>

        <div className="form-group">
          <label>{copy.businessType}</label>
          <select
            className="form-input"
            value={profile.businessType}
            onChange={(e) => setProfile({ ...profile, businessType: e.target.value })}
          >
            <option value="sole_proprietor">{copy.soleProprietor}</option>
            <option value="partnership">{copy.partnership}</option>
            <option value="company">{copy.company}</option>
          </select>
        </div>

        <div className="form-group">
          <label>{copy.county}</label>
          <select
            className="form-input"
            value={profile.county}
            onChange={(e) => setProfile({ ...profile, county: e.target.value })}
          >
            <option value="">{copy.countyPlaceholder}</option>
            {(compliance?.counties || KENYA_COUNTIES_FALLBACK).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>{copy.kraPin}</label>
          <select
            className="form-input"
            value={profile.kraPin}
            onChange={(e) => setProfile({ ...profile, kraPin: e.target.value })}
          >
            <option value="unknown">{copy.kraUnknown}</option>
            <option value="yes">{copy.kraYes}</option>
            <option value="no">{copy.kraNo}</option>
          </select>
        </div>

        <div className="form-group">
          <label>{copy.estimatedTurnover}</label>
          <input
            className="form-input"
            type="number"
            min="0"
            step="1000"
            value={profile.estimatedAnnualTurnover}
            onChange={(e) => setProfile({ ...profile, estimatedAnnualTurnover: e.target.value })}
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={savingProfile || !online}>
          {savingProfile ? 'Saving…' : copy.saveProfile}
        </button>
      </form>

      <div className="logger-card">
        <h3>{copy.heading}</h3>
        <p className="stock-lead">{copy.intro}</p>

        {compliance?.turnover && (
          <div className="compliance-turnover">
            <div>
              <span className="metric-label">{copy.ledgerTurnover}</span>
              <span className="mono">{formatKsh(compliance.turnover.ledger12m)}</span>
            </div>
            <div>
              <span className="metric-label">{copy.usedTurnover}</span>
              <span className="mono">{formatKsh(compliance.turnover.used)}</span>
            </div>
          </div>
        )}

        {loadingCompliance && !compliance ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
            <div className="loading-spinner" />
          </div>
        ) : (
          <div className="compliance-list">
            {(compliance?.obligations || []).map((row) => (
              <article className={`compliance-card ${row.applies ? 'applies' : 'quiet'}`} key={row.id}>
                <header>
                  <h4>{row.title}</h4>
                  <span className={STATUS_CLASS[row.status] || STATUS_CLASS.ok}>
                    {row.applies ? statusLabel(copy, row.status) : copy.notApplicable}
                  </span>
                </header>
                <p>{row.explanation}</p>
                {row.deadline && (
                  <p className="compliance-deadline">
                    {copy.nextDeadline}: {new Date(row.deadline).toLocaleDateString()}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}

        {compliance?.triggers?.length > 0 && (
          <div className="compliance-triggers">
            {compliance.triggers.map((row) => (
              <p key={row.id} className="offline-capture-note">{row.message}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function statusLabel(copy, status) {
  if (status === 'action_needed') return copy.statusAction;
  if (status === 'upcoming') return copy.statusUpcoming;
  if (status === 'overdue') return copy.statusOverdue;
  return copy.statusOk;
}

const COMPLIANCE_LABELS_FALLBACK = {
  heading: 'Tax and business compliance',
  intro: 'What applies to your shop from the details you gave us, plus sales already on the ledger.',
  profileHeading: 'Your shop profile',
  profileHint: 'A few details decide which obligations apply.',
  businessType: 'Business type',
  soleProprietor: 'Sole proprietor',
  partnership: 'Partnership',
  company: 'Company',
  county: 'County',
  countyPlaceholder: 'Select county',
  kraPin: 'Do you have a KRA PIN?',
  kraUnknown: 'Not sure yet',
  kraYes: 'Yes',
  kraNo: 'Not yet',
  estimatedTurnover: 'Estimated annual turnover (KSh)',
  saveProfile: 'Save profile',
  notApplicable: 'Does not apply',
  statusOk: 'On track',
  statusAction: 'Action needed',
  statusUpcoming: 'Deadline soon',
  statusOverdue: 'Deadline passed',
  nextDeadline: 'Next deadline',
  ledgerTurnover: 'Ledger sales (12 months)',
  usedTurnover: 'Turnover used for rules'
};

const KENYA_COUNTIES_FALLBACK = [
  'Baringo', 'Bomet', 'Bungoma', 'Busia', 'Elgeyo-Marakwet', 'Embu',
  'Garissa', 'Homa Bay', 'Isiolo', 'Kajiado', 'Kakamega', 'Kericho',
  'Kiambu', 'Kilifi', 'Kirinyaga', 'Kisii', 'Kisumu', 'Kitui',
  'Kwale', 'Laikipia', 'Lamu', 'Machakos', 'Makueni', 'Mandera',
  'Marsabit', 'Meru', 'Migori', 'Mombasa', 'Murang\'a', 'Nairobi',
  'Nakuru', 'Nandi', 'Narok', 'Nyamira', 'Nyandarua', 'Nyeri',
  'Samburu', 'Siaya', 'Taita-Taveta', 'Tana River', 'Tharaka-Nithi',
  'Trans Nzoia', 'Turkana', 'Uasin Gishu', 'Vihiga', 'Wajir', 'West Pokot'
];
