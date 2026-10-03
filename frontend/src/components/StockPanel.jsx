import React, { useEffect, useRef, useState } from 'react';
import { API_BASE, isOffline } from '../lib/api.js';
import { formatKsh, timeAgo } from '../lib/format.js';

const emptyManual = { item: '', qty: '', unit_cost: '', pieces_per_pack: '1', supplier: '' };

const emptyRow = () => ({ item: '', qty: '', unit_cost: '', pieces_per_pack: '1', total: '' });

const roundMoney = (value) => Math.round(Number(value) * 100) / 100;

const MAX_RECEIPT_EDGE = 1600;
const JPEG_QUALITY = 0.82;

/**
 * Phone cameras send HEIC, huge files, or no mime type. Turn whatever we
 * got into a JPEG the backend and Gemini can actually read.
 */
async function prepareReceiptFile(file) {
  if (!file) return null;
  const name = (file.name || '').toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_RECEIPT_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (blob && blob.size > 0) {
      return new File([blob], 'receipt.jpg', { type: 'image/jpeg' });
    }
  } catch {
    // HEIC on some Androids cannot be decoded here — send the original.
  }

  const type = file.type && file.type !== 'application/octet-stream' ? file.type : 'image/jpeg';
  const filename = name && name.includes('.') ? file.name : 'receipt.jpg';
  return new File([file], filename, { type });
}

function isPhoneLike() {
  if (typeof navigator === 'undefined') return false;
  if (navigator.userAgentData?.mobile) return true;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: response.ok ? 'Unexpected response from the receipt reader' : `Could not reach the stock API (${response.status})` };
  }
}

/**
 * Stock tab: upload a supplier receipt (Gemini reads it), review the lines,
 * or type a purchase in when there is no slip. Nothing is written until the
 * owner confirms — phone photos are often blurry, and a bad total would
 * poison the weekly profit figures.
 */
export default function StockPanel({ business, online, onSaved, onError, onSuccess }) {
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [lots, setLots] = useState([]);
  const [webcamOpen, setWebcamOpen] = useState(false);
  const [webcamReady, setWebcamReady] = useState(false);
  const [loadingLots, setLoadingLots] = useState(false);

  const [parsing, setParsing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [fileName, setFileName] = useState('');
  const [review, setReview] = useState(null);
  const [saving, setSaving] = useState(false);

  const [manual, setManual] = useState(emptyManual);
  const [savingManual, setSavingManual] = useState(false);

  const fetchLots = async () => {
    if (!business) return;
    setLoadingLots(true);
    try {
      const response = await fetch(`${API_BASE}/stock?businessId=${business.id}`);
      if (!response.ok) throw new Error('Could not load stock');
      setLots(await response.json());
    } catch (err) {
      console.warn('Stock list failed:', err);
    } finally {
      setLoadingLots(false);
    }
  };

  const stopWebcam = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setWebcamReady(false);
    setWebcamOpen(false);
  };

  const startWebcam = async () => {
    onError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      onError('This browser cannot open the webcam. Use Choose file and pick a picture of the receipt.');
      fileInputRef.current?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      streamRef.current = stream;
      setWebcamOpen(true);
      setWebcamReady(false);
    } catch {
      onError('Webcam permission was denied or no camera was found. Use Choose file instead.');
      fileInputRef.current?.click();
    }
  };

  const snapWebcam = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    stopWebcam();
    if (!blob) {
      onError('Could not capture that frame. Try Choose file.');
      return;
    }
    await handleFile(new File([blob], 'receipt.jpg', { type: 'image/jpeg' }));
  };

  const onTakePhoto = () => {
    if (isPhoneLike()) {
      cameraInputRef.current?.click();
      return;
    }
    startWebcam();
  };

  useEffect(() => {
    fetchLots();
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
    // business.id is the only identity we care about; preview cleanup runs on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business?.id]);

  useEffect(() => {
    if (!webcamOpen || !videoRef.current || !streamRef.current) return;
    videoRef.current.srcObject = streamRef.current;
    const onReady = () => setWebcamReady(true);
    videoRef.current.addEventListener('loadedmetadata', onReady);
    videoRef.current.play().catch(() => {});
    return () => videoRef.current?.removeEventListener('loadedmetadata', onReady);
  }, [webcamOpen]);

  const resetReview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setFileName('');
    setReview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  };

  const openReview = ({ supplier = '', date = '', rows, rejected = [], mock = false }) => {
    setReview({
      supplier,
      date: date ? String(date).slice(0, 10) : '',
      rows: rows?.length ? rows : [emptyRow()],
      rejected,
      mock
    });
  };

  const handleFile = async (file) => {
    if (!file) return;
    onError(null);
    onSuccess(null);

    if (isOffline() || !online) {
      onError('Reading a receipt needs network — type the stock in below while you are offline.');
      return;
    }

    const prepared = await prepareReceiptFile(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const canPreview = prepared.type.startsWith('image/');
    setPreviewUrl(canPreview ? URL.createObjectURL(prepared) : null);
    setFileName(prepared.name || file.name || 'receipt.jpg');

    setParsing(true);
    try {
      const formData = new FormData();
      formData.append('receipt', prepared, prepared.name || 'receipt.jpg');
      formData.append('businessId', business.id);

      const response = await fetch(`${API_BASE}/stock/receipt/parse`, {
        method: 'POST',
        body: formData
      });
      const data = await readJsonSafe(response);

      if (!response.ok) {
        // Keep the photo on screen so the owner can still type the lines
        // and tap Save — a failed read must not block submit.
        onError(data.error || 'Could not read this receipt. Type the lines from the photo and save.');
        openReview({ rows: [emptyRow()] });
        return;
      }

      openReview({
        supplier: data.supplier || '',
        date: data.date || '',
        rows: (data.line_items || []).map((row) => ({
          item: row.item,
          qty: String(row.qty),
          unit_cost: String(row.unit_cost),
          pieces_per_pack: String(row.pieces_per_pack || 1),
          total: String(row.total)
        })),
        rejected: data.rejected || [],
        mock: Boolean(data.mock)
      });
    } catch {
      onError('Connection to the receipt reader failed. Type the lines from the photo and save.');
      openReview({ rows: [emptyRow()] });
    } finally {
      setParsing(false);
    }
  };

  const updateRow = (index, field, value) => {
    setReview((current) => {
      if (!current) return current;
      const rows = current.rows.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, [field]: value };
        if (field === 'qty' || field === 'unit_cost') {
          const qty = Number(next.qty);
          const cost = Number(next.unit_cost);
          next.total = Number.isFinite(qty) && Number.isFinite(cost)
            ? String(roundMoney(qty * cost))
            : '';
        }
        return next;
      });
      return { ...current, rows };
    });
  };

  const removeRow = (index) => {
    setReview((current) => current
      ? { ...current, rows: current.rows.filter((_, i) => i !== index) }
      : current);
  };

  const addRow = () => {
    setReview((current) => current
      ? { ...current, rows: [...current.rows, emptyRow()] }
      : current);
  };

  const handleConfirm = async (event) => {
    event.preventDefault();
    if (!review) return;

    onError(null);
    onSuccess(null);
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE}/stock/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          source: 'receipt',
          supplier: review.supplier,
          date: review.date || undefined,
          items: review.rows
        })
      });
      const data = await response.json();
      if (!response.ok) {
        onError(data.error || 'Could not save this receipt');
        return;
      }
      onSuccess(`Saved ${data.count} stock ${data.count === 1 ? 'item' : 'items'} from the receipt.`);
      resetReview();
      fetchLots();
      onSaved?.();
    } catch {
      onError('Connection failed while saving stock');
    } finally {
      setSaving(false);
    }
  };

  const handleManual = async (event) => {
    event.preventDefault();
    onError(null);
    onSuccess(null);

    if (isOffline() || !online) {
      onError('Saving stock needs network so the weekly report stays in sync.');
      return;
    }

    setSavingManual(true);
    try {
      const response = await fetch(`${API_BASE}/stock/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          item: manual.item,
          qty: manual.qty,
          unit_cost: manual.unit_cost,
          pieces_per_pack: manual.pieces_per_pack || 1,
          supplier: manual.supplier
        })
      });
      const data = await response.json();
      if (!response.ok) {
        onError(data.error || 'Could not save this stock entry');
        return;
      }
      onSuccess(`Logged stock: ${manual.item} (${manual.qty} × ${formatKsh(manual.unit_cost)})`);
      setManual(emptyManual);
      fetchLots();
      onSaved?.();
    } catch {
      onError('Connection failed while saving stock');
    } finally {
      setSavingManual(false);
    }
  };

  const manualTotal = Number(manual.qty) * Number(manual.unit_cost);
  const showManualTotal = Number.isFinite(manualTotal) && manualTotal > 0;

  return (
    <div className="stock-panel">
      <div className="logger-card">
        <h3>Upload a supplier receipt</h3>
        <p className="stock-lead">
          Photograph the slip or pick a PDF. Gemini reads the lines — you check
          them before anything is saved.
        </p>

        {!online && (
          <p className="offline-capture-note">
            Receipt reading needs network. Type the stock in below and it is
            written the next time you are online.
          </p>
        )}

        <div className={`stock-dropzone ${parsing ? 'is-busy' : ''}`}>
          <strong>{parsing ? 'Reading receipt…' : 'Add a receipt'}</strong>
          <div className="stock-upload-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={parsing || saving || !online}
              onClick={onTakePhoto}
            >
              Option A · Take photo
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={parsing || saving || !online}
              onClick={() => fileInputRef.current?.click()}
            >
              Option B · Choose file
            </button>
          </div>
          <span>
            A opens the camera. B opens your files (photo or PDF).
          </span>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            disabled={parsing || saving || !online}
            onChange={(event) => {
              handleFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            hidden
            disabled={parsing || saving || !online}
            onChange={(event) => {
              handleFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>

        {previewUrl && (
          <img className="stock-preview" src={previewUrl} alt="Uploaded receipt preview" />
        )}
        {!previewUrl && fileName && (
          <p className="stock-filename">Selected: {fileName}</p>
        )}
      </div>

      {webcamOpen && (
        <div className="modal-overlay">
          <div className="modal-card webcam-card">
            <h3>Hold the receipt up to the webcam</h3>
            <p>Allow camera access if the browser asks. Then snap when the slip is readable.</p>
            <video ref={videoRef} className="webcam-preview" autoPlay playsInline muted />
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={stopWebcam}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={snapWebcam} disabled={!webcamReady}>
                {webcamReady ? 'Snap receipt' : 'Starting camera…'}
              </button>
            </div>
          </div>
        </div>
      )}

      {review && (
        <form className="logger-card stock-review" onSubmit={handleConfirm}>
          <h3>Review before saving</h3>
          <p className="stock-lead">
            Correct any line Gemini misread. A total that does not add up will
            be rejected.
          </p>

          {review.mock && (
            <p className="offline-capture-note">
              Mock mode — sample line items (no Gemini charge). Swap in a real
              key to read an actual photo.
            </p>
          )}

          {review.rejected.length > 0 && (
            <div className="error-message">
              Skipped {review.rejected.length} unreadable{' '}
              {review.rejected.length === 1 ? 'line' : 'lines'}. Add them by hand
              if they belong on this slip.
            </div>
          )}

          <div className="stock-meta-grid">
            <div className="form-group">
              <label>Supplier</label>
              <input
                className="form-input"
                value={review.supplier}
                onChange={(e) => setReview({ ...review, supplier: e.target.value })}
                placeholder="e.g. Nairobi Wholesalers"
              />
            </div>
            <div className="form-group">
              <label>Receipt date</label>
              <input
                type="date"
                className="form-input"
                value={review.date}
                onChange={(e) => setReview({ ...review, date: e.target.value })}
              />
            </div>
          </div>

          <div className="stock-lines">
            {review.rows.map((row, index) => (
              <div className="stock-line" key={`row-${index}`}>
                <div className="form-group">
                  <label>Item</label>
                  <input
                    className="form-input"
                    value={row.item}
                    onChange={(e) => updateRow(index, 'item', e.target.value)}
                    required
                  />
                </div>
                <div className="stock-line-nums">
                  <div className="form-group">
                    <label>Qty</label>
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      step="any"
                      value={row.qty}
                      onChange={(e) => updateRow(index, 'qty', e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Unit cost</label>
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      step="any"
                      value={row.unit_cost}
                      onChange={(e) => updateRow(index, 'unit_cost', e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Total</label>
                    <input className="form-input mono" value={row.total} readOnly tabIndex={-1} />
                  </div>
                  <div className="form-group">
                    <label>Pieces you sell</label>
                    <input
                      className="form-input"
                      type="number"
                      min="1"
                      step="any"
                      value={row.pieces_per_pack || '1'}
                      onChange={(e) => updateRow(index, 'pieces_per_pack', e.target.value)}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="stock-remove"
                  onClick={() => removeRow(index)}
                  disabled={review.rows.length === 1}
                >
                  Remove line
                </button>
              </div>
            ))}
          </div>

          <button type="button" className="stock-add-line" onClick={addRow}>
            + Add another item
          </button>

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={resetReview} disabled={saving}>
              Discard
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || review.rows.length === 0}>
              {saving ? 'Saving…' : 'Save stock'}
            </button>
          </div>
        </form>
      )}

      <div className="divider-text">OR TYPE STOCK IN</div>

      <form className="logger-card" onSubmit={handleManual}>
        <h3>No receipt? Type it in</h3>
        <p className="stock-lead">
          What you paid for the pack. If you buy a bar of soap and sell pieces,
          write how many pieces come from that bar.
        </p>

        <div className="form-group">
          <label>Item</label>
          <input
            className="form-input"
            placeholder="e.g. Sugar 2kg"
            value={manual.item}
            onChange={(e) => setManual({ ...manual, item: e.target.value })}
            required
            disabled={savingManual}
          />
        </div>

        <div className="stock-line-nums">
          <div className="form-group">
            <label>Quantity</label>
            <input
              className="form-input"
              type="number"
              min="0"
              step="any"
              placeholder="10"
              value={manual.qty}
              onChange={(e) => setManual({ ...manual, qty: e.target.value })}
              required
              disabled={savingManual}
            />
          </div>
          <div className="form-group">
            <label>Unit cost (KSh)</label>
            <input
              className="form-input"
              type="number"
              min="0"
              step="any"
              placeholder="280"
              value={manual.unit_cost}
              onChange={(e) => setManual({ ...manual, unit_cost: e.target.value })}
              required
              disabled={savingManual}
            />
          </div>
          <div className="form-group">
            <label>Pieces you sell</label>
            <input
              className="form-input"
              type="number"
              min="1"
              step="any"
              placeholder="1"
              value={manual.pieces_per_pack}
              onChange={(e) => setManual({ ...manual, pieces_per_pack: e.target.value })}
              disabled={savingManual}
            />
          </div>
        </div>

        <div className="form-group">
          <label>Supplier (optional)</label>
          <input
            className="form-input"
            placeholder="e.g. Gikomba wholesaler"
            value={manual.supplier}
            onChange={(e) => setManual({ ...manual, supplier: e.target.value })}
            disabled={savingManual}
          />
        </div>

        {showManualTotal && (
          <p className="stock-running-total mono">
            Line total {formatKsh(manualTotal)}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={savingManual || !online}>
          {savingManual ? 'Saving…' : 'Save stock entry'}
        </button>
      </form>

      <div className="ledger-section">
        <div className="section-header">
          <h3>Recent stock purchases</h3>
          <button type="button" className="stock-refresh" onClick={fetchLots}>
            Refresh
          </button>
        </div>

        {loadingLots && lots.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '30px 0' }}>
            <div className="loading-spinner" />
          </div>
        ) : lots.length === 0 ? (
          <p className="stock-empty">
            No stock recorded yet. Upload a receipt or type the first purchase
            above — sales will then show a real margin on the till slip.
          </p>
        ) : (
          <div className="ledger-list">
            {lots.map((lot) => (
              <div className="ledger-item purchase" key={lot._id}>
                <div className="item-details">
                  <span className="item-name">{lot.item}</span>
                  <div className="item-meta">
                    <span>{lot.qty} × {formatKsh(lot.unit_cost)}{Number(lot.pieces_per_pack) > 1 ? ` · ${lot.pieces_per_pack} pieces` : ''}</span>
                    <span>•</span>
                    <span className={`badge badge-${lot.source}`}>{lot.source}</span>
                    {lot.supplier ? (
                      <>
                        <span>•</span>
                        <span>{lot.supplier}</span>
                      </>
                    ) : null}
                    <span>•</span>
                    <span>{timeAgo(lot.purchase_date || lot.created_at)}</span>
                  </div>
                </div>
                <div className="item-amount-area">
                  <span className="item-amount mono">{formatKsh(lot.total)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
