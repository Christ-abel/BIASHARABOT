import mongoose from 'mongoose';
import { DEFAULT_REPORT_LANGUAGE, REPORT_LANGUAGES } from '../languages.js';

const LANGUAGE_CODES = REPORT_LANGUAGES.map((row) => row.code);

const businessSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true },
  password: { type: String, required: true },
  complianceProfile: { type: complianceSchema, default: () => ({}) },
  tillNumber: { type: String, default: () => process.env.PAYHERO_CHANNEL_ID || '6669' },
  // Missing on old records → mongoose (and normalizeReportLanguage) treat as en.
  reportLanguage: {
    type: String,
    enum: LANGUAGE_CODES,
    default: DEFAULT_REPORT_LANGUAGE
  },
  businessType: {
    type: String,
    enum: ['sole_proprietor', 'partnership', 'company'],
    default: 'sole_proprietor'
  },
  county: { type: String, default: '' },
  // 'unknown' is the prompt-to-complete state for shops that signed up
  // before we asked about a KRA PIN. false would wrongly look decided.
  kraPin: { type: String, enum: ['unknown', 'yes', 'no'], default: 'unknown' },
  estimatedAnnualTurnover: { type: Number, default: 0, min: 0 },
  created_at: { type: Date, default: Date.now }
});

export default mongoose.model('Business', businessSchema);
