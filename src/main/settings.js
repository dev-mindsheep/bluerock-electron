// Settings store: plain JSON in userData, with secret fields encrypted at rest
// via Electron safeStorage (Keychain on macOS, DPAPI on Windows).
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const SECRET_PATHS = [
  'email.password',
  'ai.anthropicKey',
  'ai.openaiKey',
  'qb.clientSecret',
  'qb.tokens',
  'drive.clientSecret',
  'drive.tokens',
];

export const DEFAULTS = {
  general: {
    authorizedSenders: [], // empty list = accept attachments from any sender
    pollMinutes: 5,
  },
  email: {
    enabled: false,
    host: '',
    port: 993,
    secure: true,
    user: '',
    password: '',
  },
  ai: {
    provider: 'anthropic', // 'anthropic' | 'openai'
    anthropicKey: '',
    anthropicModel: 'claude-opus-4-8',
    openaiKey: '',
    openaiModel: 'gpt-4o',
    useAiForTypedPdfs: 'always', // 'always' (default: AI-first) | 'auto' (parser first, AI fallback) | 'never'
  },
  qb: {
    mode: 'mock', // 'mock' | 'sandbox' | 'production'
    clientId: '',
    clientSecret: '',
    redirectPort: 8123,
    // Production OAuth redirect — must be public HTTPS and registered in the
    // Intuit app (localhost is sandbox-only per Intuit policy). This page shows
    // the code + realmId for pasting back via Manual code entry.
    productionRedirectUri: 'https://www.mindsheeplabs.com/legal/bluerock-callback.html',
    // Bills are payables to the market supplier, which usually can't be
    // identified from the KAR request — so they default to Blue Rock's
    // existing placeholder vendor "UNKNOWN" (resolved to its Id at connect
    // time) and the team reassigns the real supplier in QBO.
    vendorId: '',
    vendorName: '',
    // Sage prefix -> QBO expense account (value = QBO Account Id).
    // Keys = the 15 prefixes in Blue Rock's System Code mapping plus ITDE
    // (real KAR PRs #28961, #33582) and TOEQ (PR #33114), both missing from
    // the mapping sheet — target accounts unconfirmed with Alan. Unknown
    // prefixes fall back to defaultAccountId.
    accountMap: {
      CHEM: '', CIVL: '', ELEC: '', FIRE: '', FURN: '', INST: '', IT: '',
      ITDE: '', LABO: '', MECH: '', MEDI: '', OFSU: '', SAFE: '', SRVC: '',
      STAT: '', TOEQ: '', TOOL: '',
    },
    defaultAccountId: '',
    // Invoice to KAR (accounts receivable), created alongside the supplier bill
    // when enabled. Line price = unit cost x (1 + margin%). The customer is
    // Blue Rock's QBO customer record for KAR — resolved from customerName to
    // its Id on first push (or set the Id manually). Invoice lines need a QBO
    // Product/Service item; one named invoiceItemName is looked up and created
    // (as a Service item) if the company doesn't have it yet.
    createInvoice: false,
    defaultMarginPct: 0,
    customerId: '',
    customerName: 'KAR',
    invoiceItemId: '',
    invoiceItemName: 'KAR Procurement',
    // Blue Rock's invoice form carries three custom fields (seen on real
    // invoices, e.g. 3055): "PO #" (gets the PR/SR reference), "Service
    // Ticket" (typed by the reviewer per document), and "Location" (gets the
    // extracted project site). Each field's QBO DefinitionId resolves from its
    // label on the first push that needs it. Service Ticket resolution is
    // strict (the reviewer typed a value expecting it to land); PO #/Location
    // are best-effort so companies without those fields (sandbox) still push.
    serviceTicketFieldName: 'Service Ticket',
    serviceTicketFieldId: '',
    poFieldName: 'PO #',
    poFieldId: '',
    locationFieldName: 'Location',
    locationFieldId: '',
    // Invoice terms, resolved by name on first push (best-effort — QBO's
    // customer/company default applies if the name isn't found).
    invoiceTermName: 'Net 30',
    invoiceTermId: '',
    // "Message on invoice" (CustomerMemo) — prints on the invoice itself.
    // Blue Rock's standard wire-transfer instructions; newlines preserved.
    invoiceMessage: 'For Wire Transfer:\n'
      + 'Account Name: Al Sakhir Al Azraq for General Trading LTD\n'
      + 'Account Type: Current - IQD\n'
      + 'Bank Name: National Bank of Iraq\n'
      + 'Account Number: 2100014963\n'
      + 'IBAN Number: IQ16NBIQ857002100014963\n'
      + 'Swift Code: NBIQIQBA\n'
      + 'Bank Address: 100M Road, Erbil, Iraq\n'
      + 'Intermediary Bank:\n'
      + 'Account Name: Capital Bank of Jordan\n'
      + 'Account Number: 3612-5139\n'
      + 'SWIFT: EFBKJOAM',
    // Sage code -> QBO Item Id cache: invoice lines show the line's Sage code
    // in the Product/Service column, so each distinct code becomes a Service
    // item (auto-created on first use, remembered here).
    itemMap: {},
    tokens: null, // { access_token, refresh_token, expires_at, realmId }
  },
  drive: {
    enabled: false,
    clientId: '',
    clientSecret: '',
    redirectPort: 8124,
    rootFolderName: 'KAR',
    // Blue Rock's master tracking sheet (one row per Service Ticket). When
    // enabled, the review screen can reserve the next ST number in the sheet,
    // and each pushed order completes its row (status, QB invoice number,
    // bill register). Uses the Drive connection's Google account — the sheet
    // must be owned by or shared (edit) with it, and the Google Sheets API
    // must be enabled in the same GCP project as the Drive client.
    trackingEnabled: false,
    trackingSheetUrl: '',
    trackingSheetTab: 'Operation',
    tokens: null,
  },
};

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ?? (o[k] = {});
  o[keys[keys.length - 1]] = value;
}

function encryptValue(v) {
  const json = JSON.stringify(v);
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(json).toString('base64');
  }
  return 'plain:' + Buffer.from(json).toString('base64');
}
function decryptValue(s) {
  try {
    if (typeof s !== 'string') return s;
    if (s.startsWith('enc:')) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')));
    }
    if (s.startsWith('plain:')) {
      return JSON.parse(Buffer.from(s.slice(6), 'base64').toString('utf8'));
    }
    return s;
  } catch {
    return null;
  }
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function getSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch { /* first run */ }
  const merged = deepMerge(DEFAULTS, raw);
  for (const p of SECRET_PATHS) {
    const v = getPath(merged, p);
    if (typeof v === 'string' && (v.startsWith('enc:') || v.startsWith('plain:'))) {
      setPath(merged, p, decryptValue(v));
    }
  }
  return merged;
}

export function saveSettings(patch) {
  const current = getSettings();
  const merged = deepMerge(current, patch);
  const toWrite = JSON.parse(JSON.stringify(merged));
  for (const p of SECRET_PATHS) {
    const v = getPath(toWrite, p);
    if (v !== undefined && v !== null && v !== '') setPath(toWrite, p, encryptValue(v));
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(toWrite, null, 2));
  return merged;
}
