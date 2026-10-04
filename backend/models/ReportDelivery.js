import mongoose from 'mongoose';

/**
 * One row per till-slip SMS we tried to send.
 *
 * The row is written *before* the SMS goes out. For the scheduled weekly
 * run, `dedupe_key` (shop + week) is unique, so two overlapping cron runs
 * cannot both text the same shop: the second insert fails and is skipped.
 * Owner-requested resends carry no dedupe_key and are rate-limited instead.
 */
const reportDeliverySchema = new mongoose.Schema({
  business_id: { type: String, required: true, index: true },
  trigger: { type: String, enum: ['schedule', 'manual'], required: true },
  period_start: { type: String, required: true },
  period_end: { type: String, required: true },
  dedupe_key: { type: String, unique: true, sparse: true },
  status: { type: String, enum: ['sending', 'sent', 'failed'], required: true },
  attempts: { type: Number, default: 1 },
  to: { type: String },
  parts: { type: Number },
  mock: { type: Boolean, default: false },
  ref_id: { type: String, index: true, sparse: true },
  error: { type: String },
  error_code: { type: String },
  // Filled in by the Tiara DELIVERY_REPORT webhook when it can be matched.
  delivery_status: { type: String },
  delivered_at: { type: Date },
  sent_at: { type: Date },
  created_at: { type: Date, default: Date.now }
});

export default mongoose.model('ReportDelivery', reportDeliverySchema);
