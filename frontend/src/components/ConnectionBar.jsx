import React from 'react';
import { timeAgo } from '../lib/format.js';

const OfflineIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="conn-icon">
    <line x1="1" y1="1" x2="23" y2="23" />
    <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
    <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
    <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
    <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
    <line x1="12" y1="20" x2="12.01" y2="20" />
  </svg>
);

const SyncIcon = ({ spinning }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    className={`conn-icon ${spinning ? 'spinning' : ''}`}
  >
    <path d="M21 2v6h-6" />
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M3 22v-6h6" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
  </svg>
);

const CloudDoneIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="conn-icon">
    <path d="M18 16.5a4 4 0 0 0-1.2-7.8A6 6 0 0 0 5.3 10 3.5 3.5 0 0 0 6 16.9" />
    <polyline points="9 13.5 11.5 16 16 11" />
  </svg>
);

/**
 * The always-visible connectivity strip: what state the network is in, how
 * many entries are still on this phone, and a way to push them now.
 */
export default function ConnectionBar({
  online,
  pendingCount,
  failedCount,
  syncing,
  lastSyncedAt,
  onSync,
}) {
  let tone = 'synced';
  let icon = <CloudDoneIcon />;
  let title = 'Online — everything is synced';
  let detail = lastSyncedAt ? `Last sync ${timeAgo(lastSyncedAt)}` : 'Entries upload as you log them';

  if (!online) {
    tone = 'offline';
    icon = <OfflineIcon />;
    title = 'Offline — you can keep recording';
    detail = pendingCount
      ? `${pendingCount} ${pendingCount === 1 ? 'entry' : 'entries'} saved on this phone`
      : 'New entries save on this phone and sync later';
  } else if (syncing) {
    tone = 'syncing';
    icon = <SyncIcon spinning />;
    title = 'Syncing…';
    detail = `Uploading ${pendingCount} ${pendingCount === 1 ? 'entry' : 'entries'}`;
  } else if (pendingCount > 0) {
    tone = 'pending';
    icon = <SyncIcon />;
    title = `${pendingCount} ${pendingCount === 1 ? 'entry' : 'entries'} waiting to upload`;
    detail = 'They will sync automatically — or tap Sync now';
  }

  return (
    <div className={`connection-bar tone-${tone}`} role="status" aria-live="polite">
      <div className="conn-main">
        {icon}
        <div className="conn-text">
          <span className="conn-title">{title}</span>
          <span className="conn-detail">{detail}</span>
        </div>
      </div>

      <div className="conn-actions">
        {failedCount > 0 && (
          <span className="conn-badge failed">
            {failedCount} need{failedCount === 1 ? 's' : ''} attention
          </span>
        )}
        {online && pendingCount > 0 && (
          <button type="button" className="conn-sync-btn" onClick={() => onSync({ force: true })} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>
    </div>
  );
}
