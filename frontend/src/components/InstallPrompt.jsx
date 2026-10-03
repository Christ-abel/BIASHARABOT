import React, { useEffect, useState } from 'react';
import { canInstall, isIos, isStandalone, promptInstall, subscribeInstallState } from '../lib/pwa.js';

const DISMISS_KEY = 'biashara_install_dismissed';

/**
 * Invitation to install the app to the home screen. Installing matters here
 * beyond convenience: an installed PWA keeps its cache and offline queue, and
 * launches with no network at all.
 *
 * Chrome/Edge/Android get the real install dialog; iOS Safari has no such API,
 * so it gets the Share-sheet steps instead.
 */
export default function InstallPrompt() {
  const [installable, setInstallable] = useState(canInstall());
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === 'true'
  );
  const [showIosSteps, setShowIosSteps] = useState(false);

  useEffect(() => subscribeInstallState(() => setInstallable(canInstall())), []);

  if (isStandalone() || dismissed) return null;

  const iosOnly = !installable && isIos();
  if (!installable && !iosOnly) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, 'true');
    setDismissed(true);
  };

  const install = async () => {
    const accepted = await promptInstall();
    if (accepted) dismiss();
  };

  return (
    <div className="install-card">
      <div className="install-text">
        <strong>Install BiasharaBot on this phone</strong>
        <span>Works without network — record sales anywhere, they sync when you get signal.</span>
        {showIosSteps && (
          <ol className="install-steps">
            <li>Tap the Share button in Safari's toolbar.</li>
            <li>Scroll and choose “Add to Home Screen”.</li>
            <li>Tap “Add” — then open BiasharaBot from your home screen.</li>
          </ol>
        )}
      </div>

      <div className="install-actions">
        {installable ? (
          <button type="button" className="btn btn-primary install-btn" onClick={install}>
            Install
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary install-btn"
            onClick={() => setShowIosSteps((shown) => !shown)}
          >
            {showIosSteps ? 'Hide steps' : 'How to install'}
          </button>
        )}
        <button type="button" className="install-dismiss" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
