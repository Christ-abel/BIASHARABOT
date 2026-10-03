import React, { useState, useEffect, useRef } from 'react';
import { API_BASE, isNetworkError, isOffline } from './lib/api.js';
import { readSnapshot, saveSnapshot } from './lib/idb.js';
import {
  discardOutboxItem,
  enqueueTextEntry,
  enqueueVoiceEntry,
  retryOutboxItem,
} from './lib/outbox.js';
import { formatKsh, formatPercent, timeAgo } from './lib/format.js';
import { useOfflineSync } from './hooks/useOfflineSync.js';
import ConnectionBar from './components/ConnectionBar.jsx';
import PendingEntries from './components/PendingEntries.jsx';
import InstallPrompt from './components/InstallPrompt.jsx';
import UpdateBanner from './components/UpdateBanner.jsx';
import StockPanel from './components/StockPanel.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';

// The service worker replays the last good API response when the network is
// gone, and stamps it so the UI can say "this is a saved copy" instead of
// passing stale figures off as live ones.
const servedFromCache = (response) => response.headers.get('X-Biashara-From-Cache') === '1';

// Home-screen shortcuts in the manifest deep-link with ?tab=...
const initialTab = () => {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return ['ledger', 'stock', 'report', 'settings', 'admin'].includes(tab) ? tab : 'ledger';
};

// SVG Icons
const MicIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 6h12v12H6z" />
  </svg>
);

const SendIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ width: '16px', height: '16px' }}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const AlertIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '16px', height: '16px' }}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

const LockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '24px', height: '24px', color: 'var(--color-baked-clay)', marginBottom: '12px' }}>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

export default function App() {
  // Setup / Auth State
  const [business, setBusiness] = useState(() => {
    const saved = localStorage.getItem('biashara_business');
    return saved ? JSON.parse(saved) : null;
  });
  const [setupName, setSetupName] = useState('');
  const [setupPhone, setSetupPhone] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirmPassword, setSetupConfirmPassword] = useState('');
  const [setupComplianceProfile, setSetupComplianceProfile] = useState(emptyComplianceProfile);

  // Main UI State
  const [activeTab, setActiveTab] = useState(initialTab); // 'ledger' (Dashboard), 'report' (Till slip), 'admin' (Admin Ledger)
  const [entries, setEntries] = useState([]);
  // Set when the ledger/report on screen came from the offline snapshot
  // instead of the server, so the UI can say how stale it is.
  const [entriesSavedAt, setEntriesSavedAt] = useState(null);
  const [reportSavedAt, setReportSavedAt] = useState(null);
  const [textEntry, setTextEntry] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // Admin Verification State
  const [adminPassword, setAdminPassword] = useState('');
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(() => {
    return sessionStorage.getItem('biashara_admin_auth') === 'true';
  });
  const [adminError, setAdminError] = useState(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [maskSensitiveData, setMaskSensitiveData] = useState(true); // Defaults to true for default privacy shield

  // Audio Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);
  // Duration also lives in a ref: MediaRecorder's onstop closure would
  // otherwise read the value from the render that started the recording.
  const durationRef = useRef(0);

  // STK Push Modal State
  const [showStkModal, setShowStkModal] = useState(false);
  const [stkEntryId, setStkEntryId] = useState(null);
  const [stkPhone, setStkPhone] = useState('');
  const [stkLoading, setStkLoading] = useState(false);

  // Weekly Report State
  const [report, setReport] = useState(null);
  const [reportLabels, setReportLabels] = useState(null);
  // True when the server could not translate and served English instead.
  const [reportLanguageFallback, setReportLanguageFallback] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [smsStatus, setSmsStatus] = useState(null);

  // Simulator State
  const [showSimulator, setShowSimulator] = useState(false);
  const [simAmount, setSimAmount] = useState('');
  const [simPhone, setSimPhone] = useState('254712345678');
  const [simEntryId, setSimEntryId] = useState('');
  const [simLoading, setSimLoading] = useState(false);

  // Fetch entries, falling back to the last snapshot saved on this device so
  // the ledger still opens in a dead spot.
  const fetchEntries = async () => {
    if (!business) return;
    const cacheKey = `entries:${business.id}`;
    try {
      const response = await fetch(`${API_BASE}/entries?businessId=${business.id}`);
      if (!response.ok) throw new Error(`Ledger request failed (${response.status})`);

      const data = await response.json();
      setEntries(data);

      if (servedFromCache(response)) {
        const snapshot = await readSnapshot(cacheKey);
        setEntriesSavedAt(snapshot?.savedAt || response.headers.get('date') || null);
      } else {
        setEntriesSavedAt(null);
        saveSnapshot(cacheKey, data);
      }
    } catch (err) {
      console.warn('Serving ledger from offline snapshot:', err);
      const snapshot = await readSnapshot(cacheKey);
      if (snapshot) {
        setEntries(snapshot.data);
        setEntriesSavedAt(snapshot.savedAt);
      }
    }
  };

  // Fetch weekly report + trigger SMS automatically on load
  const fetchReportAndSendSMS = async () => {
    if (!business) return;
    const cacheKey = `report:${business.id}`;
    setReportLoading(true);
    setSmsStatus(null);
    try {
      const response = await fetch(
        `${API_BASE}/reports/weekly?businessId=${business.id}&phone=${business.phone}&businessName=${encodeURIComponent(
          business.name
        )}`
      );
      if (!response.ok) throw new Error(`Report request failed (${response.status})`);

      const data = await response.json();
      setReport(data.report);
      setReportLabels(data.labels || null);
      setReportLanguageFallback(Boolean(data.languageFallback));

      if (servedFromCache(response)) {
        // A replayed response means no SMS went out just now — saying it did
        // would be a lie the owner might act on.
        const snapshot = await readSnapshot(cacheKey);
        setReportSavedAt(snapshot?.savedAt || response.headers.get('date') || null);
        setSmsStatus(null);
        return;
      }

      setReportSavedAt(null);
      // Keep the labels with the figures so an offline till slip stays in the
      // owner's language instead of dropping back to English.
      saveSnapshot(cacheKey, { figures: data.report, labels: data.labels || null, language: data.language || 'en' });
      if (data.smsStatus && data.smsStatus.success) {
        setSmsStatus({ success: true, message: `Weekly report SMS sent automatically to ${business.phone}!` });
      } else {
        setSmsStatus({ success: false, error: 'SMS notification scheduled but service is offline' });
      }
    } catch (err) {
      console.warn('Serving weekly report from offline snapshot:', err);
      const snapshot = await readSnapshot(cacheKey);
      if (snapshot) {
        // Snapshots saved before reports carried labels hold the bare figures.
        const saved = snapshot.data || {};
        setReport(saved.figures || saved);
        setReportLabels(saved.labels || null);
        setReportLanguageFallback(false);
        setReportSavedAt(snapshot.savedAt);
        setSmsStatus(null);
      } else {
        setError('No saved till slip on this phone yet — connect once to generate it.');
      }
    } finally {
      setReportLoading(false);
    }
  };

  // Connectivity + the queue of entries captured offline. Declared after the
  // fetchers so onSynced can refresh the ledger once uploads land.
  const {
    online,
    pending,
    failed,
    pendingCount,
    failedCount,
    syncing,
    lastSyncedAt,
    sync,
  } = useOfflineSync(business?.id, {
    onSynced: (count) => {
      setSuccess(
        `${count} offline ${count === 1 ? 'entry' : 'entries'} uploaded and reconciled.`
      );
      fetchEntries();
    },
  });

  const persistBusiness = (next) => {
    localStorage.setItem('biashara_business', JSON.stringify(next));
    setBusiness(next);
  };

  // Trigger data load on mount or business change
  useEffect(() => {
    if (business) {
      fetchEntries();
      fetch(`${API_BASE}/business/${business.id}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((fresh) => {
          if (!fresh) return;
          persistBusiness({ ...business, ...fresh });
        })
        .catch(() => {});
    }
  }, [business?.id]);

  // Handle active tab change
  useEffect(() => {
    setError(null);
    setSuccess(null);
    if (activeTab === 'report' && business) {
      fetchReportAndSendSMS();
    } else {
      fetchEntries();
    }
  }, [activeTab]);

  // Handle Business Sign-up (Communicates with database endpoint)
  const handleSetupSubmit = async (e) => {
    e.preventDefault();
    if (!setupName.trim() || !setupPhone.trim() || !setupEmail.trim() || !setupPassword || !setupConfirmPassword) {
      setError('Please fill in all fields');
      return;
    }
    if (setupPassword !== setupConfirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/business`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: setupName,
          phone: setupPhone,
          email: setupEmail,
          password: setupPassword,
          confirmPassword: setupConfirmPassword,
          complianceProfile: setupComplianceProfile
        })
      });

      if (response.ok) {
        const newBiz = await response.json();
        localStorage.setItem('biashara_business', JSON.stringify(newBiz));
        setBusiness(newBiz);
        setSetupName('');
        setSetupPhone('');
        setSetupEmail('');
        setSetupPassword('');
        setSetupConfirmPassword('');
      } else {
        const errData = await response.json();
        setError(errData.error || 'Failed to sign up business');
      }
    } catch (err) {
      setError('Connection to backend failed');
    } finally {
      setLoading(false);
    }
  };

  // Saves a transaction on the phone when the server is out of reach. Nothing
  // is ever lost to a dead spot; the outbox uploads it later.
  const queueTextEntry = async (text) => {
    const item = await enqueueTextEntry({ businessId: business.id, text });
    setTextEntry('');
    setSuccess(
      item.provisional
        ? `Saved on this phone: ${item.provisional.item} ≈ ${formatKsh(item.provisional.total)}. It will sync when you have network.`
        : 'Saved on this phone. It will sync and be priced when you have network.'
    );
    return item;
  };

  const queueVoiceEntry = async (audioBlob, durationSec) => {
    await enqueueVoiceEntry({
      businessId: business.id,
      audio: audioBlob,
      mimeType: audioBlob.type,
      durationSec,
    });
    setSuccess(
      'Voice note saved on this phone. It will be transcribed and logged as soon as you have network.'
    );
  };

  // Handle Text Logging
  const handleTextSubmit = async (e) => {
    e.preventDefault();
    if (!textEntry.trim()) return;

    setLoading(true);
    setError(null);
    setSuccess(null);

    if (isOffline()) {
      try {
        await queueTextEntry(textEntry);
      } catch (err) {
        setError('Could not save this entry on the phone');
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/entries/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: textEntry,
          businessId: business.id
        })
      });

      if (response.ok) {
        const newEntry = await response.json();
        setTextEntry('');
        setSuccess(`Logged: "${newEntry.transcription || newEntry.item}" (${newEntry.qty} x KSh ${newEntry.unit_price} = KSh ${newEntry.total.toLocaleString()})`);
        fetchEntries();
      } else if (response.status >= 500) {
        // Server reachable but broken — queue rather than lose the sale.
        await queueTextEntry(textEntry);
      } else {
        const errData = await response.json();
        setError(errData.error || 'Failed to parse text transaction');
      }
    } catch (err) {
      if (isNetworkError(err)) {
        await queueTextEntry(textEntry);
      } else {
        setError('Connection to backend failed');
      }
    } finally {
      setLoading(false);
    }
  };

  // Voice Note Recording
  const startRecording = async () => {
    audioChunksRef.current = [];
    setError(null);
    setSuccess(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // MediaRecorder picks its own container; keep it so the backend gets a
        // mime type Gemini can actually read (Safari records mp4, not webm).
        const recordedType = mediaRecorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(audioChunksRef.current, { type: recordedType });
        await uploadAudio(audioBlob, durationRef.current);
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingDuration(0);
      durationRef.current = 0;

      timerRef.current = setInterval(() => {
        durationRef.current += 1;
        setRecordingDuration(durationRef.current);
      }, 1000);
    } catch (err) {
      setError('Microphone access denied or not supported.');
      console.error(err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      clearInterval(timerRef.current);
    }
  };

  const uploadAudio = async (audioBlob, durationSec = 0) => {
    setLoading(true);

    // Offline: keep the recording itself. Transcription needs the server, so
    // the note is queued as audio and parsed when it uploads.
    if (isOffline()) {
      try {
        await queueVoiceEntry(audioBlob, durationSec);
      } catch (err) {
        setError('Could not save this voice note on the phone');
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'voice_note.webm');
      formData.append('businessId', business.id);

      const response = await fetch(`${API_BASE}/entries/voice`, {
        method: 'POST',
        body: formData
      });

      if (response.ok) {
        const newEntry = await response.json();
        setSuccess(`Transcribed: "${newEntry.transcription || newEntry.item}" — Logged: ${newEntry.item} (${newEntry.qty} x KSh ${newEntry.unit_price} = KSh ${newEntry.total.toLocaleString()})`);
        fetchEntries();
      } else if (response.status >= 500) {
        await queueVoiceEntry(audioBlob, durationSec);
      } else {
        const errData = await response.json();
        setError(errData.error || 'Failed to parse voice entry');
      }
    } catch (err) {
      if (isNetworkError(err)) {
        await queueVoiceEntry(audioBlob, durationSec);
      } else {
        setError('Connection to voice API failed');
      }
    } finally {
      setLoading(false);
    }
  };

  // Admin Password Verification
  const handleAdminVerify = async (e) => {
    e.preventDefault();
    if (!adminPassword) return;

    // The password is verified server-side (bcrypt), so this one needs network.
    if (isOffline()) {
      setAdminError('You are offline. Unlocking the admin ledger needs network.');
      return;
    }

    setAdminLoading(true);
    setAdminError(null);

    try {
      const response = await fetch(`${API_BASE}/admin/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword, businessId: business.id })
      });

      if (response.ok) {
        setIsAdminAuthenticated(true);
        sessionStorage.setItem('biashara_admin_auth', 'true');
        setAdminPassword('');
        fetchEntries();
      } else {
        const errData = await response.json();
        setAdminError(errData.error || 'Incorrect password');
      }
    } catch (err) {
      setAdminError('Server connection error during login');
    } finally {
      setAdminLoading(false);
    }
  };

  const handleAdminLock = () => {
    setIsAdminAuthenticated(false);
    sessionStorage.removeItem('biashara_admin_auth');
  };

  // STK Push Triggering
  const openStkModal = (entryId) => {
    setStkEntryId(entryId);
    setStkPhone(business.phone);
    setShowStkModal(true);
  };

  const handleStkSubmit = async (e) => {
    e.preventDefault();
    if (!stkPhone.trim()) return;

    // An STK push has to reach the customer's phone now; there is nothing
    // useful to queue for later.
    if (isOffline()) {
      setError('STK push needs network — the customer must get the prompt right away.');
      setShowStkModal(false);
      return;
    }

    setStkLoading(true);
    try {
      const response = await fetch(`${API_BASE}/payments/stk-push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryId: stkEntryId,
          phone: stkPhone
        })
      });

      if (response.ok) {
        const data = await response.json();
        setSuccess(`STK Push sent to ${stkPhone}! Reference: ${data.merchant_reference}`);
        setShowStkModal(false);
        fetchEntries();
      } else {
        const errData = await response.json();
        setError(errData.error || 'Failed to initiate STK push');
      }
    } catch (err) {
      setError('Payment gateway request failed');
    } finally {
      setStkLoading(false);
    }
  };

  // Webhook Simulator
  const handleSimulateWebhook = async (e) => {
    e.preventDefault();
    if (!simAmount) return;

    setSimLoading(true);
    try {
      const response = await fetch(`${API_BASE}/webhooks/payhero`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'success',
          amount: parseFloat(simAmount),
          external_reference: simEntryId,
          phone: simPhone,
          service_charge: parseFloat(simAmount) * 0.01
        })
      });

      if (response.ok) {
        setSuccess(`Simulated M-Pesa webhook callback received for KSh ${simAmount}`);
        setSimAmount('');
        setSimEntryId('');
        fetchEntries();
      } else {
        setError('Simulation failed on backend server');
      }
    } catch (err) {
      setError('Simulation connection error');
    } finally {
      setSimLoading(false);
    }
  };

  // Logout (Immediately logs out to resolve confirm popups blocking headless browser tests)
  const handleLogout = () => {
    localStorage.removeItem('biashara_business');
    sessionStorage.removeItem('biashara_admin_auth');
    setBusiness(null);
    setEntries([]);
    setReport(null);
  };

  // Calculate Running Totals for Today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayEntries = entries.filter((e) => new Date(e.timestamp) >= todayStart);
  const sumByType = (rows, type) =>
    rows.filter((e) => e.type === type).reduce((s, e) => s + (Number(e.total) || 0), 0);

  // Entries still sitting in the outbox count towards today as well — the sale
  // happened, it just has not reached the server. Typed entries contribute
  // their on-device estimate; voice notes have no figure until they sync.
  const pendingToday = pending.filter((item) => new Date(item.createdAt) >= todayStart);
  const provisionalToday = pendingToday.map((item) => item.provisional).filter(Boolean);
  const unpricedPendingCount = pendingToday.length - provisionalToday.length;

  const todayRevenue = sumByType(todayEntries, 'sale') + sumByType(provisionalToday, 'sale');
  const todayPurchases =
    sumByType(todayEntries, 'purchase') + sumByType(provisionalToday, 'purchase');
  const todayExpenses =
    sumByType(todayEntries, 'expense') + sumByType(provisionalToday, 'expense');
  const todayNet = todayRevenue - todayPurchases - todayExpenses;
  const totalsAreEstimates = provisionalToday.length > 0;

  // Unmatched entries list for webhook simulator dropdown
  const unmatchedSales = entries.filter((e) => e.type === 'sale' && !e.matched && e.source !== 'payhero');

  if (!business) {
    return (
      <div className="app-container">
        <header>
          <h1>BiasharaBot</h1>
          <p>Kenyan's Number one shop assistant</p>
        </header>
        <div className="content">
          <InstallPrompt />
          <form className="setup-card" onSubmit={handleSetupSubmit}>
            <h2>Business Sign Up</h2>
            <p>Register your duka or shop</p>

            {!online && (
              <div className="error-message">
                You are offline. Signing up needs network once — after that the app records sales
                without it.
              </div>
            )}

            {error && <div className="error-message">{error}</div>}

            <div className="form-group">
              <label>Business Name</label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. Otieno Wholesalers"
                value={setupName}
                onChange={(e) => setSetupName(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            <div className="form-group">
              <label>Mobile Number (For SMS weekly reports)</label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. 0712345678"
                value={setupPhone}
                onChange={(e) => setSetupPhone(e.target.value)}
                required
                disabled={loading}
              />
            </div>


            <div className="form-group">
              <label>Email Address (For account recovery & invoices)</label>
              <input
                type="email"
                className="form-input"
                placeholder="name@business.com"
                value={setupEmail}
                onChange={(e) => setSetupEmail(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            <div className="form-group">
              <label>Setup Admin Password</label>
              <input
                type="password"
                className="form-input"
                placeholder="Choose Admin Password"
                value={setupPassword}
                onChange={(e) => setSetupPassword(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            <div className="form-group">
              <label>Confirm Admin Password</label>
              <input
                type="password"
                className="form-input"
                placeholder="Confirm Admin Password"
                value={setupConfirmPassword}
                onChange={(e) => setSetupConfirmPassword(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            <details className="compliance-profile"><summary>Business compliance details (optional)</summary>
              <ComplianceProfileFields profile={setupComplianceProfile} onChange={setSetupComplianceProfile} brief disabled={loading} />
            </details>
            <button type="submit" className="btn btn-primary" disabled={loading || !online}>
              {loading ? <div className="loading-spinner" style={{ borderColor: 'var(--color-indigo-ink)' }} /> : 'Register & Sync'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1>{business.name}</h1>
            <p>Logged in: {business.phone}</p>
          </div>
          <button
            onClick={handleLogout}
            id="logout-btn"
            style={{
              background: 'none',
              border: '1px solid #E8A33D',
              color: '#E8A33D',
              padding: '6px 12px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 'bold'
            }}
          >
            Log Out
          </button>
        </div>
      </header>

      <UpdateBanner />

      <ConnectionBar
        online={online}
        pendingCount={pendingCount}
        failedCount={failedCount}
        syncing={syncing}
        lastSyncedAt={lastSyncedAt}
        onSync={sync}
      />

      <div className="nav-tabs">
        <button className={`nav-tab ${activeTab === 'compliance' ? 'active' : ''}`} onClick={() => setActiveTab('compliance')}>Compliance</button>
        <button
          className={`nav-tab ${activeTab === 'ledger' ? 'active' : ''}`}
          onClick={() => setActiveTab('ledger')}
        >
          Daily Ledger
        </button>
        <button
          className={`nav-tab ${activeTab === 'stock' ? 'active' : ''}`}
          onClick={() => setActiveTab('stock')}
        >
          Stock
        </button>
        <button
          className={`nav-tab ${activeTab === 'report' ? 'active' : ''}`}
          onClick={() => setActiveTab('report')}
        >
          Weekly till slip
        </button>
        <button
          className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
        <button
          className={`nav-tab ${activeTab === 'admin' ? 'active' : ''}`}
          onClick={() => setActiveTab('admin')}
        >
          Admin Ledger
        </button>
      </div>

      <div className="content">
        {error && <div className="error-message">{error}</div>}
        {success && <div className="success-message">{success}</div>}
        {activeTab === 'compliance' && <ComplianceCheck key={business.id} business={business} />}

        {activeTab === 'ledger' && (
          <>
            <InstallPrompt />
            <button className="compliance-dashboard-link" onClick={() => setActiveTab('compliance')}>Check your tax & business obligations → Complete your business profile</button>

            {(!business.county || business.kraPin === 'unknown' || !business.kraPin) && (
              <button
                type="button"
                className="offline-capture-note compliance-banner"
                onClick={() => setActiveTab('settings')}
              >
                Finish your shop profile to see the tax and permit deadlines that apply to you.
              </button>
            )}

            {/* Today's Summary Metrics */}
            <div className="metrics-grid">
              <div className="metric-card">
                <span className="metric-label">Today's Sales</span>
                <span className="metric-val mono">
                  {totalsAreEstimates ? '≈ ' : ''}KSh {todayRevenue.toLocaleString()}
                </span>
              </div>
              <div className={`metric-card ${todayNet >= 0 ? 'profit-positive' : 'profit-negative'}`}>
                <span className="metric-label">Today's Profit</span>
                <span className="metric-val mono">
                  {totalsAreEstimates ? '≈ ' : ''}KSh {todayNet.toLocaleString()}
                </span>
              </div>
            </div>

            {(totalsAreEstimates || unpricedPendingCount > 0 || entriesSavedAt) && (
              <div className="totals-note">
                {totalsAreEstimates && (
                  <span>
                    Includes {provisionalToday.length} unsynced{' '}
                    {provisionalToday.length === 1 ? 'entry' : 'entries'} counted from this phone.{' '}
                  </span>
                )}
                {unpricedPendingCount > 0 && (
                  <span>
                    {unpricedPendingCount === 1
                      ? '1 voice note is not priced yet, so it is left out until it syncs.'
                      : `${unpricedPendingCount} voice notes are not priced yet, so they are left out until they sync.`}{' '}
                  </span>
                )}
                {entriesSavedAt && (
                  <span>Server figures are the copy saved on this phone {timeAgo(entriesSavedAt)}.</span>
                )}
              </div>
            )}

            {/* Quick Logging Input Panel */}
            <div className="logger-card torn-divider-bottom">
              <h3>Log New Transaction</h3>
              <p style={{ fontSize: '13px', color: '#5A524E', marginBottom: '16px' }}>
                Tap the microphone to speak, or type details below:
              </p>

              {!online && (
                <p className="offline-capture-note">
                  No network right now — recordings and typed entries are saved on this phone and
                  upload themselves later.
                </p>
              )}

              <div className="voice-recording-area">
                <button
                  className={`mic-btn ${isRecording ? 'recording' : ''}`}
                  onClick={isRecording ? stopRecording : startRecording}
                  disabled={loading}
                >
                  {isRecording ? <StopIcon /> : <MicIcon />}
                </button>
                <div className={`recording-status ${isRecording ? 'active' : ''}`}>
                  {isRecording ? `Recording... (${recordingDuration}s)` : 'Tap to Record Voice'}
                </div>
              </div>

              <div className="divider-text">OR TYPE ENTRY</div>

              <form onSubmit={handleTextSubmit} className="text-entry-area">
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. sold 10 loaves at 50 each..."
                  value={textEntry}
                  onChange={(e) => setTextEntry(e.target.value)}
                  disabled={loading || isRecording}
                />
                <button
                  type="submit"
                  className="btn btn-secondary btn-send"
                  disabled={loading || isRecording || !textEntry.trim()}
                >
                  {loading ? <div className="loading-spinner" /> : <SendIcon />}
                </button>
              </form>
            </div>
            
            <PendingEntries
              items={pending}
              failed={failed}
              onRetry={retryOutboxItem}
              onDiscard={discardOutboxItem}
            />

            <div style={{ textAlign: 'center', marginTop: '30px', color: 'var(--color-gray-dark)', fontSize: '13px' }}>
              ℹ️ Transaction history and developer simulations have been relocated to the protected <strong>Admin Ledger</strong> tab.
            </div>
          </>
        )}

        {activeTab === 'stock' && (
          <StockPanel
            business={business}
            online={online}
            onSaved={fetchEntries}
            onError={setError}
            onSuccess={setSuccess}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsPanel
            business={business}
            online={online}
            onBusinessChange={persistBusiness}
            onError={setError}
            onSuccess={setSuccess}
          />
        )}

        {activeTab === 'report' && (
          /* Weekly receipt till slip view (SMS sent automatically on render) */
          <div className="receipt-wrapper">
            {reportLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '50px 0' }}>
                <div className="loading-spinner" />
              </div>
            ) : report ? (
              <>
                {reportSavedAt && (
                  <div className="offline-snapshot-note">
                    Showing the till slip saved on this phone {timeAgo(reportSavedAt)}. It refreshes
                    — and the SMS goes out — once you have network.
                  </div>
                )}

                {smsStatus && (
                  <div className={smsStatus.success ? 'success-message' : 'error-message'}>
                    📢 {smsStatus.message || smsStatus.error}
                  </div>
                )}

                {reportLanguageFallback && (
                  <div className="offline-snapshot-note">
                    {reportLabels?.languageFallbackNote || 'Showing English — translation was unavailable.'}
                  </div>
                )}

                <div className="receipt-card">
                  <div className="receipt-title">BiasharaBot</div>
                  <div className="receipt-subtitle">
                    {business.name.toUpperCase()} {reportLabels?.weeklySubtitle || 'WEEKLY REPORT'}
                  </div>

                  <div className="receipt-divider" />

                  <div className="receipt-row">
                    <span className="label">{reportLabels?.revenue || 'REVENUE'}</span>
                    <span className="value mono">KSh {report.revenue.toFixed(2)}</span>
                  </div>

                  <div className="receipt-row">
                    <span className="label">{reportLabels?.costOfGoods || 'COST OF GOODS (PURCHASES)'}</span>
                    <span className="value mono">KSh {report.cost_of_goods.toFixed(2)}</span>
                  </div>

                  <div className="receipt-row">
                    <span className="label">{reportLabels?.otherExpenses || 'OTHER EXPENSES'}</span>
                    <span className="value mono">KSh {report.other_expenses.toFixed(2)}</span>
                  </div>

                  <div className="receipt-row">
                    <span className="label">{reportLabels?.mpesaFees || 'M-PESA CHARGES (PAYHERO)'}</span>
                    <span className="value mono">KSh {report.mpesa_fees.toFixed(2)}</span>
                  </div>

                  <div className="dotted-rule" />

                  <div
                    className={`receipt-row total-row ${
                      report.net_profit >= 0 ? 'positive' : 'negative'
                    }`}
                  >
                    <span className="label">{reportLabels?.netProfit || 'NET PROFIT'}</span>
                    <span className="value mono">KSh {report.net_profit.toFixed(2)}</span>
                  </div>

                  <div className="dotted-rule" />

                  <div className="receipt-section-title">{reportLabels?.grossProfitByItem || 'GROSS PROFIT BY ITEM'}</div>
                  <p className="receipt-section-note">
                    {reportLabels?.grossNote ||
                      'Cost of goods sold uses the unit cost you recorded on Stock. Net profit above is still cash in minus cash out.'}
                  </p>

                  {Array.isArray(report.item_profits) && report.item_profits.length > 0 ? (
                    report.item_profits.map((row) => (
                      <div className="receipt-item-profit" key={row.item}>
                        <div className="receipt-row">
                          <span className="label">{row.item.toUpperCase()}</span>
                          <span className="value mono">
                            {row.cost_unknown
                              ? (reportLabels?.noCostYet || 'NO COST YET')
                              : `KSh ${Number(row.gross_profit).toFixed(2)}`}
                          </span>
                        </div>
                        <div className="receipt-item-meta">
                          {row.qty_sold} {reportLabels?.sold || 'sold'} · {reportLabels?.rev || 'rev'} {formatKsh(row.revenue)}
                          {row.cost_unknown
                            ? ` · ${reportLabels?.addStockForMargin || 'add stock to see margin'}`
                            : ` · ${reportLabels?.cost || 'cost'} ${formatKsh(row.cogs)} · ${formatPercent(row.margin)}`}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="receipt-item-meta" style={{ marginBottom: '10px' }}>
                      {reportLabels?.noSales || 'No sales this week yet.'}
                    </div>
                  )}

                  {report.items_missing_cost > 0 && (
                    <div className="receipt-item-meta" style={{ marginBottom: '8px' }}>
                      {(reportLabels?.itemsMissingCost || '{count} sold item(s) have no stock cost yet').replace(
                        '{count}',
                        String(report.items_missing_cost)
                      )}
                    </div>
                  )}

                  <div
                    className={`receipt-row total-row ${
                      Number(report.gross_profit || 0) >= 0 ? 'positive' : 'negative'
                    }`}
                  >
                    <span className="label">{reportLabels?.grossProfit || 'GROSS PROFIT'}</span>
                    <span className="value mono">
                      KSh {Number(report.gross_profit || 0).toFixed(2)}
                      {Number.isFinite(report.gross_margin) ? ` (${formatPercent(report.gross_margin)})` : ''}
                    </span>
                  </div>

                  <div className="dotted-rule" />

                  <div className="receipt-row">
                    <span className="label">{reportLabels?.outstandingCredit || 'OUTSTANDING CREDIT'}</span>
                    <span className="value mono" style={{ color: '#8E44AD' }}>
                      KSh {report.outstanding_credit.toFixed(2)}
                    </span>
                  </div>

                  <div className="receipt-footer-text">
                    {reportLabels?.printedAt || 'Printed at'} {new Date().toLocaleDateString()}<br />
                    {reportLabels?.poweredBy || 'Powered by BiasharaBot'}
                  </div>
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '30px 0' }}>Failed to load weekly report</div>
            )}
          </div>
        )}

        {activeTab === 'admin' && (
          /* Separate Admin page: Password lock + Full history listing + Simulator drawer */
          <div className="admin-wrapper">
            {!isAdminAuthenticated ? (
              <div className="setup-card" style={{ marginTop: '20px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
                  <LockIcon />
                  <h2>Admin Access Required</h2>
                  <p>Please enter the admin password to view and reconcile transaction history logs.</p>
                </div>

                {adminError && <div className="error-message">{adminError}</div>}

                <form onSubmit={handleAdminVerify}>
                  <div className="form-group">
                    <label>Admin Password</label>
                    <input
                      type="password"
                      className="form-input"
                      placeholder="Enter Admin Password"
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      required
                    />
                  </div>

                  <button type="submit" className="btn btn-secondary" disabled={adminLoading}>
                    {adminLoading ? 'Verifying...' : 'Unlock Ledger'}
                  </button>
                </form>
              </div>
            ) : (
              <>
                {/* Unlocked Admin Ledger list */}
                <div className="ledger-section">
                  <div className="section-header">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <h3>Transactions History</h3>
                        <span style={{ fontSize: '12px', background: 'var(--color-gray-light)', padding: '2px 8px', borderRadius: '12px', fontWeight: 'bold' }}>
                          Admin Mode
                        </span>
                      </div>
                      
                      {/* Privacy Shield Switch (Abstraction layer) */}
                      <label className="privacy-toggle-container">
                        <input
                          type="checkbox"
                          checked={maskSensitiveData}
                          onChange={(e) => setMaskSensitiveData(e.target.checked)}
                        />
                        <span>Mask Financial Figures (Hover to Reveal)</span>
                      </label>
                    </div>
                    
                    <div style={{ display: 'flex', gap: '10px', alignSelf: 'flex-start', marginTop: '6px' }}>
                      <button
                        onClick={fetchEntries}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#1B2A4A',
                          fontSize: '13px',
                          cursor: 'pointer',
                          fontWeight: 'bold'
                        }}
                      >
                        Refresh
                      </button>
                      <span style={{ color: 'var(--color-gray-medium)' }}>|</span>
                      <button
                        onClick={handleAdminLock}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--color-baked-clay)',
                          fontSize: '13px',
                          cursor: 'pointer',
                          fontWeight: 'bold'
                        }}
                      >
                        Lock
                      </button>
                    </div>
                  </div>

                  <PendingEntries
                    items={pending}
                    failed={failed}
                    onRetry={retryOutboxItem}
                    onDiscard={discardOutboxItem}
                    masked={maskSensitiveData}
                  />

                  {entriesSavedAt && (
                    <div className="offline-snapshot-note">
                      This history is the copy saved on the phone {timeAgo(entriesSavedAt)} — it
                      refreshes when you have network.
                    </div>
                  )}

                  {entries.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '40px 0', color: '#5A524E' }}>
                      No ledger entries found.
                    </div>
                  ) : (
                    <div className="ledger-list">
                      {entries.map((entry) => (
                        <div className={`ledger-item ${entry.type}`} key={entry._id}>
                          <div className="item-details">
                            {/* Mask customer details / spontaneous Mpesa items if privacy toggle is enabled */}
                            <span className={`item-name ${entry.item.includes('M-Pesa') && maskSensitiveData ? 'privacy-blurred' : ''}`}>
                              {entry.item}
                            </span>
                            <div className="item-meta">
                              <span style={{ textTransform: 'capitalize', fontWeight: 'bold' }}>
                                {entry.type}
                              </span>
                              <span>•</span>
                              <span className={maskSensitiveData ? 'privacy-blurred' : ''} title="Hover to view calculation details">
                                {entry.qty} x KSh {entry.unit_price}
                              </span>
                              <span>•</span>
                              <span className={`badge badge-${entry.source}`}>{entry.source}</span>
                            </div>
                          </div>

                          <div className="item-amount-area">
                            <span className={`item-amount mono ${maskSensitiveData ? 'privacy-blurred' : ''}`} title="Hover to view transaction total">
                              KSh {entry.total.toLocaleString()}
                            </span>

                            {entry.type === 'sale' && (
                              <div className="payment-status">
                                {entry.matched ? (
                                  <span className="status-matched">
                                    <CheckIcon /> Paid (M-Pesa)
                                  </span>
                                ) : entry.source === 'payhero' ? (
                                  <span className="status-unmatched">
                                    <AlertIcon /> Unreconciled
                                  </span>
                                ) : (
                                  <span className="status-pending" onClick={() => openStkModal(entry._id)}>
                                    Request STK Push
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Developer Webhook Simulator inside Admin page */}
                <div style={{ marginTop: '40px', borderTop: '2px solid #EBE4D8', paddingTop: '20px' }}>
                  <button
                    onClick={() => setShowSimulator(!showSimulator)}
                    style={{
                      width: '100%',
                      padding: '10px',
                      backgroundColor: '#F6EFE3',
                      border: '2px dashed #E8A33D',
                      color: '#E8A33D',
                      borderRadius: '8px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '13px',
                      cursor: 'pointer',
                      fontWeight: 'bold'
                    }}
                  >
                    {showSimulator ? 'Close M-Pesa Webhook Simulator' : 'Open M-Pesa Webhook Simulator'}
                  </button>

                  {showSimulator && (
                    <div className="simulator-drawer">
                      <h4>
                        <span style={{ fontSize: '18px' }}>⚡</span> M-Pesa Webhook Simulator
                      </h4>
                      <p>Simulate a PayHero callback confirming a payment. Resolves on localhost without ngrok.</p>

                      <form onSubmit={handleSimulateWebhook}>
                        <div className="form-group" style={{ marginBottom: '12px' }}>
                          <label style={{ fontSize: '12px' }}>Match Existing Unpaid Sale:</label>
                          <select
                            className="form-input"
                            style={{ padding: '8px', fontSize: '13px' }}
                            value={simEntryId}
                            onChange={(e) => {
                              setSimEntryId(e.target.value);
                              const selected = unmatchedSales.find((x) => x._id === e.target.value);
                              if (selected) {
                                setSimAmount(selected.total.toString());
                              }
                            }}
                          >
                            <option value="">-- No Match (Spontaneous Payment) --</option>
                            {unmatchedSales.map((x) => (
                              <option key={x._id} value={x._id}>
                                {x.item} - KSh {x.total} ({new Date(x.timestamp).toLocaleTimeString()})
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="simulator-form">
                          <div className="form-group" style={{ marginBottom: '0' }}>
                            <label style={{ fontSize: '12px' }}>Payment Amount (KSh)</label>
                            <input
                              type="number"
                              className="form-input"
                              style={{ padding: '8px', fontSize: '13px' }}
                              placeholder="e.g. 500"
                              value={simAmount}
                              onChange={(e) => setSimAmount(e.target.value)}
                              required
                            />
                          </div>

                          <div className="form-group" style={{ marginBottom: '0' }}>
                            <label style={{ fontSize: '12px' }}>Customer Phone</label>
                            <input
                              type="text"
                              className="form-input"
                              style={{ padding: '8px', fontSize: '13px' }}
                              value={simPhone}
                              onChange={(e) => setSimPhone(e.target.value)}
                              required
                            />
                          </div>
                        </div>

                        <button
                          type="submit"
                          className="btn btn-primary"
                          style={{
                            padding: '8px 12px',
                            fontSize: '13px',
                            marginTop: '12px',
                            backgroundColor: '#E8A33D',
                            color: '#1B2A4A'
                          }}
                          disabled={simLoading}
                        >
                          {simLoading ? 'Processing Webhook...' : 'Simulate Success Callback'}
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* STK Push Modal */}
      {showStkModal && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3>Request M-Pesa Payment</h3>
            <p>Send an STK push request to the customer's phone. When they approve, the webhook reconciles the transaction.</p>

            <form onSubmit={(e) => { e.preventDefault(); handleStkSubmit(e); }}>
              <div className="form-group">
                <label>Customer Mobile Number (e.g. 0712345678)</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Enter M-Pesa Phone Number"
                  value={stkPhone}
                  onChange={(e) => setStkPhone(e.target.value)}
                  required
                />
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowStkModal(false)}
                  disabled={stkLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={stkLoading || !stkPhone.trim()}
                >
                  {stkLoading ? 'Sending STK Push...' : 'Send STK Push'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
