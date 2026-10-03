import mongoose from 'mongoose';

/**
 * One SMS (or dashboard stamp) per obligation per deadline window.
 * The unique key is what stops a shop owner being pinged every time
 * they open the till slip.
 */
const complianceNoticeSchema = new mongoose.Schema({
  business_id: { type: String, required: true, index: true },
  obligation_id: { type: String, required: true },
  notice_type: {
    type: String,
    enum: ['new_obligation', 'deadline_approaching', 'threshold_crossed'],
    required: true
  },
  window_key: { type: String, required: true },
  language: { type: String, default: 'en' },
  message: { type: String, default: '' },
  sent_at: { type: Date, default: Date.now }
});

complianceNoticeSchema.index(
  { business_id: 1, obligation_id: 1, notice_type: 1, window_key: 1 },
  { unique: true }
);

export default mongoose.model('ComplianceNotice', complianceNoticeSchema);
