import React from 'react';

const labels = {
  en: { legalStructure: 'Business structure', activity: 'Business activity', county: 'County', hasKraPin: 'Does the appropriate taxpayer have a KRA PIN?', estimatedAnnualTurnover: 'Estimated annual turnover (KSh)', resident: 'Kenyan tax resident?', totExcludedIncome: 'Rental, professional, management, training or final-withholding income?', totElectionOut: 'Have you elected out of TOT with KRA?', taxableSupplies: 'Do you make VAT-taxable supplies?', estimatedTaxableTurnover: 'Taxable supplies over 12 months, including expected supplies (KSh)', vatRegistered: 'Registered for VAT?', totRegistered: 'Registered for TOT?', etimsRegistered: 'Onboarded on eTIMS?', permitExpiry: 'Permit expiry (if known)', accountingYearEndMonth: 'Company accounting year-end month (1–12)', reportLanguage: 'Guidance language', smsOptIn: 'Send compliance alerts to my registered phone', unknown: 'Not sure / not provided', yes: 'Yes', no: 'No' },
  sw: { legalStructure: 'Muundo wa biashara', activity: 'Shughuli ya biashara', county: 'Kaunti', hasKraPin: 'Mlipa kodi anayefaa ana PIN ya KRA?', estimatedAnnualTurnover: 'Makadirio ya mauzo ya mwaka (KSh)', resident: 'Mkazi wa Kenya kwa kodi?', totExcludedIncome: 'Mapato ya upangishaji, taaluma, usimamizi, mafunzo au kodi ya zuio ya mwisho?', totElectionOut: 'Umechagua kutotumia TOT kupitia KRA?', taxableSupplies: 'Una mauzo yanayotozwa VAT?', estimatedTaxableTurnover: 'Mauzo yanayotozwa VAT kwa miezi 12, pamoja na yanayotarajiwa (KSh)', vatRegistered: 'Umesajiliwa kwa VAT?', totRegistered: 'Umesajiliwa kwa TOT?', etimsRegistered: 'Umejiunga na eTIMS?', permitExpiry: 'Mwisho wa kibali (ikiwa unajua)', accountingYearEndMonth: 'Mwezi wa mwisho wa mwaka wa hesabu wa kampuni (1–12)', reportLanguage: 'Lugha ya mwongozo', smsOptIn: 'Nitumie arifa kwenye simu yangu iliyosajiliwa', unknown: 'Sina uhakika / sijatoa', yes: 'Ndiyo', no: 'Hapana' },
};
export default function ComplianceProfileFields({ profile, onChange, brief = false, disabled = false }) {
  const t = labels[profile.reportLanguage] || labels.en;
  const sw = profile.reportLanguage === 'sw';
  const set = (key, value) => onChange({ ...profile, [key]: value });
  const select = (key, options) => <div className="form-group" key={key}><label htmlFor={`compliance-${key}`}>{t[key]}</label><select id={`compliance-${key}`} className="form-input" value={profile[key]} disabled={disabled} onChange={e => set(key, e.target.value)}>{options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>;
  const tri = key => select(key, [['unknown', t.unknown], ['yes', t.yes], ['no', t.no]]);
  const input = (key, type, extra = {}) => <div className="form-group" key={key}><label htmlFor={`compliance-${key}`}>{t[key]}</label><input id={`compliance-${key}`} className="form-input" type={type} value={profile[key] ?? ''} disabled={disabled} {...extra} onChange={e => set(key, type === 'number' ? e.target.value === '' ? null : Number(e.target.value) : e.target.value)} /></div>;
  return <div className="compliance-fields">
    {select('reportLanguage', [['en', 'English'], ['sw', 'Kiswahili']])}
    {select('legalStructure', [['unknown', t.unknown], ['sole_proprietor', sw ? 'Mmiliki binafsi' : 'Sole proprietor'], ['partnership', sw ? 'Ubia' : 'Partnership'], ['company', sw ? 'Kampuni' : 'Company']])}
    {select('activity', [['unknown', t.unknown], ['retail', sw ? 'Duka' : 'Retail store'], ['online_shop', sw ? 'Duka mtandaoni' : 'Online shop'], ['food_vendor', sw ? 'Muuzaji wa chakula' : 'Food vendor'], ['freelancer', sw ? 'Mfanyakazi huru' : 'Freelancer'], ['mobile_money', sw ? 'Wakala wa pesa' : 'Mobile money agent'], ['other', sw ? 'Nyingine' : 'Other']])}
    {input('county', 'text', { maxLength: 60, placeholder: 'Nairobi' })}
    {tri('hasKraPin')}
    {input('estimatedAnnualTurnover', 'number', { min: 0, step: '0.01' })}
    {!brief && <>
      {tri('resident')}{tri('totExcludedIncome')}{tri('totElectionOut')}{tri('taxableSupplies')}
      {input('estimatedTaxableTurnover', 'number', { min: 0, step: '0.01' })}
      {tri('totRegistered')}{tri('vatRegistered')}{tri('etimsRegistered')}
      {input('permitExpiry', 'date')}
      {profile.legalStructure === 'company' && input('accountingYearEndMonth', 'number', { min: 1, max: 12, step: 1 })}
      <label className="compliance-optin"><input type="checkbox" checked={profile.smsOptIn} disabled={disabled} onChange={e => set('smsOptIn', e.target.checked)} /> {t.smsOptIn}</label>
    </>}
  </div>;
}
