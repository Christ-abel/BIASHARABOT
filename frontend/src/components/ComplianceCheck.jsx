import React, { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/api.js';
import ComplianceProfileFields from './ComplianceProfileFields.jsx';
import { emptyComplianceProfile } from '../lib/complianceProfile.js';

export default function ComplianceCheck({ business }) {
  const [token, setToken] = useState('');
  const tokenRef = useRef('');
  const [password, setPassword] = useState('');
  const [profile, setProfile] = useState(emptyComplianceProfile);
  const [assessment, setAssessment] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const sw = profile.reportLanguage === 'sw';
  // Leaving the screen or logging out revokes the scoped server session.
  useEffect(() => () => {
    if (tokenRef.current) void fetch(`${API_BASE}/compliance/lock`, { method: 'POST', headers: { Authorization: `Bearer ${tokenRef.current}` }, keepalive: true }).catch(() => {});
  }, []);
  async function request(path, options = {}, auth = token) {
    let response;
    try {
      response = await fetch(`${API_BASE}/compliance${path}`, { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...options.headers } });
    } catch {
      throw new Error(sw
        ? `Haiwezi kufikia seva (${API_BASE}). Hakikisha seva inaendesha na MongoDB imeunganishwa.`
        : `Cannot reach the backend (${API_BASE}). Make sure the backend is running and MongoDB has connected.`);
    }
    if (response.status === 404) throw new Error(sw ? 'API ya compliance haipatikani kwenye seva hii. Thibitisha anwani na toleo la seva.' : 'The compliance API is missing on this server. Check the backend address and deployed version.');
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) { setToken(''); tokenRef.current = ''; setAssessment(null); }
      throw new Error(data.error || 'Compliance request failed');
    }
    return data;
  }
  async function unlock(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const session = await request('/unlock', { method: 'POST', body: JSON.stringify({ businessId: business.id, password }) }, '');
      tokenRef.current = session.token;
      setToken(session.token); setPassword('');
      const result = await request('', {}, session.token);
      setProfile(result.profile); setAssessment(result);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try {
      await request('/profile', { method: 'PUT', body: JSON.stringify(profile) });
      const result = await request('');
      setAssessment(result); setProfile(result.profile); setSaved(true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <section className="compliance-section">
    <h2>{sw ? 'Ukaguzi wa wajibu wa biashara' : 'Business compliance check'}</h2>
    <p>{sw ? 'Mwongozo wa kodi na vibali kulingana na taarifa zako. Huu si uthibitisho wa uzingatiaji.' : 'Tax and permit guidance based on your business details. This is guidance, not certification of compliance.'}</p>
    {error && <p className="error-message" role="alert">{error}</p>}
    {!token ? <form className="setup-card" onSubmit={unlock}>
      <p>Enter your admin password to complete your business profile and view personalized guidance. An internet connection is required.</p>
      <label htmlFor="compliance-password">Admin password</label>
      <input id="compliance-password" type="password" className="form-input" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Opening…' : 'Open compliance check'}</button>
    </form> : <>
      {assessment?.missingFields.length > 0 && <p className="compliance-warning">{sw ? 'Kamilisha taarifa hapa chini kupata mwongozo unaofaa.' : 'Complete the missing business details below to refine your checklist.'}</p>}
      <details open={!assessment || assessment.missingFields.length > 0} className="compliance-profile"><summary>{sw ? 'Taarifa za biashara na SMS' : 'Business profile & SMS preferences'}</summary>
        <form onSubmit={save}><ComplianceProfileFields profile={profile} onChange={value => { setProfile(value); setSaved(false); }} disabled={busy} />
          <button className="btn btn-primary" disabled={busy}>{busy ? (sw ? 'Inahifadhi…' : 'Saving…') : (sw ? 'Hifadhi na kagua' : 'Save & update checklist')}</button>
          {saved && <p role="status">{sw ? 'Taarifa zimehifadhiwa.' : 'Profile saved.'}</p>}
        </form>
      </details>
      {assessment && <>
        <div className="compliance-revenue"><strong>{sw ? 'Mauzo yaliyorekodiwa pekee' : 'Recorded sales only'}</strong>
          <p>{assessment.ledger.calendarYear}: KSh {assessment.ledger.calendarYearRevenue.toLocaleString('en-KE')} · {sw ? 'Miezi 12 iliyopita' : 'Trailing 12 months'}: KSh {assessment.ledger.trailing12MonthRevenue.toLocaleString('en-KE')}</p>
          <small>{sw ? 'Daftari linaweza kuwa na taarifa pungufu. Mauzo yote si lazima yatozwe VAT.' : 'The ledger may be incomplete. Total sales are not necessarily VAT-taxable supplies.'}</small>
        </div>
        <div className="compliance-list">{assessment.items.map(item => <article className="compliance-card" key={item.id}>
          <div className="compliance-card-heading"><h3>{item.title}</h3><span className={`compliance-status status-${item.status}`}>{item.statusLabel}</span></div>
          <p>{item.explanation}</p>
          <p>{sw ? 'Inatumika' : 'Applies'}: {item.applicability === true ? (sw ? 'Ndiyo' : 'Yes') : item.applicability === false ? (sw ? 'Haijaonyeshwa' : 'Not triggered') : (sw ? 'Thibitisha' : 'Needs confirmation')}</p>
          {item.deadline && <p><strong>{sw ? 'Tarehe ya mwisho' : 'Next deadline'}: {item.deadline}</strong></p>}
          {item.source ? <a href={item.source} target="_blank" rel="noreferrer">{sw ? 'Mwongozo rasmi' : 'Official guidance'} ↗</a> : <small>{sw ? 'Thibitisha na kaunti yako; tarehe haijakisiwa.' : 'Confirm with your county; no renewal date has been assumed.'}</small>}
        </article>)}</div>
        {assessment.notices.length > 0 && <div className="compliance-revenue"><h3>{sw ? 'Arifa' : 'Current notices'}</h3>{assessment.notices.map(notice => <p key={notice.key}>{notice.message}</p>)}</div>}
        {assessment.history?.length > 0 && <details><summary>{sw ? 'Historia ya SMS' : 'SMS notice history'}</summary><ul>{assessment.history.map(notice => <li key={notice._id}>{notice.message} <strong>({notice.status})</strong>{notice.sentAt && ` — ${notice.sentAt.slice(0, 10)}`}</li>)}</ul></details>}
        <small>{sw ? 'Kanuni zilipitiwa' : 'Rules reviewed'}: {assessment.reviewedOn}. {sw ? 'Tarehe zinaonyeshwa kwa saa za Kenya. Marejesho yaliyochelewa hayajafuatiliwa hapa.' : 'Dates use Kenya time. Past unpaid or unfiled periods are not tracked here.'}</small>
      </>}
    </>}
  </section>;
}
