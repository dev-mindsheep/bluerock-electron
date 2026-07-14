// Pure QuickBooks Online API helpers — no Electron imports, so this module can
// be exercised headlessly (node) against the sandbox as well as from the app.
import fs from 'node:fs';
import path from 'node:path';

export function apiBase(mode) {
  return mode === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function toIsoDate(ddmmyyyy) {
  const m = (ddmmyyyy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return new Date().toISOString().slice(0, 10);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// Sage prefix -> QBO expense account NAME, per Blue Rock's System Code mapping
// sheet (docs/System Code.xlsx, received 2026-07-09). ITDE is not on the sheet
// but appears on real KAR PRs (#28961, #33582); Purchase - IT is the assumed
// target pending Alan's confirmation.
export const SAGE_ACCOUNT_NAMES = {
  CHEM: 'Purchase - Misc',
  CIVL: 'Purchase - Civil',
  ELEC: 'Purchase - Electrical',
  FIRE: 'Purchase - Misc',
  FURN: 'Purchase - Furniture',
  INST: 'Purchase - Misc',
  IT: 'Purchase - IT',
  ITDE: 'Purchase - IT',
  LABO: 'Purchase - Misc',
  MECH: 'Purchase - Misc',
  MEDI: 'Purchase - Tech & HSE',
  OFSU: 'Purchase - Misc',
  SAFE: 'Purchase - Tech & HSE',
  SRVC: 'Purchase - Misc',
  STAT: 'Purchase - Stationery',
  TOOL: 'Purchase - Misc',
};

export const DEFAULT_ACCOUNT_NAME = 'Purchase - Misc';

// Blue Rock's books already contain a vendor literally named UNKNOWN, used as
// the placeholder when the market supplier can't be identified (handwritten
// invoices). Bills default to it; the team reassigns the real supplier in QBO.
export const PLACEHOLDER_VENDOR_NAME = 'UNKNOWN';

/** Build the QBO Bill payload from a reviewed extraction. */
export function buildBillPayload(extraction, qb) {
  const lines = (extraction.line_items || []).map((li) => {
    const prefix = (li.sage_code || '').split('-')[0];
    const accountId = qb.accountMap?.[prefix] || qb.defaultAccountId || '';
    return {
      DetailType: 'AccountBasedExpenseLineDetail',
      // Amounts unknown at intake — entries land at 0.00 in review-pending state;
      // Alan's team adds cost + margin in QBO before approving the bill.
      Amount: 0,
      Description: [
        li.description,
        li.qty != null ? `Qty: ${li.qty} ${li.uom || ''}`.trim() : null,
        li.sage_code,
        li.purpose,
      ].filter(Boolean).join(' | ').slice(0, 4000),
      AccountBasedExpenseLineDetail: {
        AccountRef: accountId ? { value: String(accountId) } : undefined,
      },
    };
  });

  return {
    VendorRef: { value: String(qb.vendorId || ''), name: qb.vendorName || undefined },
    TxnDate: toIsoDate(extraction.date),
    DocNumber: extraction.number ? `${extraction.doc_type === 'service_request' ? 'SR' : 'PR'}-${extraction.number}` : undefined,
    PrivateNote: [
      `KAR ${extraction.doc_type === 'service_request' ? 'Service' : 'Purchase'} Request #${extraction.number || '?'}`,
      extraction.department ? `Dept: ${extraction.department}` : null,
      extraction.project_site ? `Site: ${extraction.project_site}` : null,
      extraction.requester_name ? `Requester: ${extraction.requester_name}` : null,
      extraction.note ? `Note: ${extraction.note}` : null,
    ].filter(Boolean).join(' | ').slice(0, 4000),
    Line: lines,
  };
}

async function qbGet(mode, accessToken, urlPath) {
  const res = await fetch(`${apiBase(mode)}${urlPath}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.Fault?.Error?.[0];
    const tid = res.headers.get('intuit_tid');
    throw new Error(`QuickBooks error ${res.status}: ${detail?.Message || ''} ${detail?.Detail || ''}${tid ? ` [intuit_tid ${tid}]` : ''}`.trim());
  }
  return body;
}

async function query(mode, accessToken, realmId, q) {
  const body = await qbGet(mode, accessToken, realmId && `/v3/company/${realmId}/query?minorversion=75&query=${encodeURIComponent(q)}`);
  return body.QueryResponse || {};
}

/**
 * Resolve QBO Ids for everything the Bill payload needs, by name:
 * the Sage-prefix expense accounts, the fallback account, and the placeholder
 * vendor. Only fills values that are currently empty — manual overrides in
 * Settings are never clobbered. Returns { qbPatch, unresolved } where qbPatch
 * is a partial qb-settings object to merge and unresolved lists what wasn't
 * found in the company (expected on sandbox companies, which have a US chart
 * of accounts).
 */
export async function resolveCompanyIds(mode, accessToken, realmId, qb) {
  const wanted = [...new Set(Object.values(SAGE_ACCOUNT_NAMES).concat(DEFAULT_ACCOUNT_NAME))];
  const nameList = wanted.map((n) => `'${n.replace(/'/g, "\\'")}'`).join(', ');
  const accounts = (await query(mode, accessToken, realmId,
    `select Id, Name from Account where Name in (${nameList})`)).Account || [];
  const idByName = Object.fromEntries(accounts.map((a) => [a.Name, a.Id]));

  const accountMap = { ...(qb.accountMap || {}) };
  const unresolved = [];
  for (const [prefix, accountName] of Object.entries(SAGE_ACCOUNT_NAMES)) {
    if (accountMap[prefix]) continue; // manual override — keep
    if (idByName[accountName]) accountMap[prefix] = String(idByName[accountName]);
    else unresolved.push(`${prefix} -> ${accountName}`);
  }

  const qbPatch = { accountMap };
  if (!qb.defaultAccountId && idByName[DEFAULT_ACCOUNT_NAME]) {
    qbPatch.defaultAccountId = String(idByName[DEFAULT_ACCOUNT_NAME]);
  }

  if (!qb.vendorId) {
    const vendors = (await query(mode, accessToken, realmId,
      `select Id, DisplayName from Vendor where DisplayName = '${PLACEHOLDER_VENDOR_NAME}'`)).Vendor || [];
    if (vendors.length) {
      qbPatch.vendorId = String(vendors[0].Id);
      qbPatch.vendorName = vendors[0].DisplayName;
    } else {
      unresolved.push(`vendor -> ${PLACEHOLDER_VENDOR_NAME}`);
    }
  }

  return { qbPatch, unresolved };
}

/**
 * List active vendors (paginated — QBO caps query pages at 1000 rows).
 * Returns [{ id, name }] sorted by name, for the review screen's vendor picker.
 */
export async function listVendors(mode, accessToken, realmId) {
  const out = [];
  for (let start = 1; ; start += 1000) {
    const page = (await query(mode, accessToken, realmId,
      `select Id, DisplayName from Vendor where Active = true orderby DisplayName startposition ${start} maxresults 1000`)).Vendor || [];
    out.push(...page.map((v) => ({ id: String(v.Id), name: v.DisplayName })));
    if (page.length < 1000) break;
  }
  return out;
}

const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

/**
 * Attach a source document to a QBO entity (Bill) via the Attachments API.
 * Multipart upload: file_metadata_01 (AttachableRef JSON) + file_content_01.
 */
export async function uploadAttachment(mode, accessToken, realmId, billId, filePath) {
  const fileName = path.basename(filePath);
  const contentType = CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
  const metadata = {
    FileName: fileName,
    ContentType: contentType,
    AttachableRef: [{ EntityRef: { value: String(billId), type: 'Bill' } }],
  };
  const form = new FormData();
  form.append('file_metadata_01',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.append('file_content_01',
    new Blob([fs.readFileSync(filePath)], { type: contentType }), fileName);

  const res = await fetch(`${apiBase(mode)}/v3/company/${realmId}/upload?minorversion=75`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  const attachable = body?.AttachableResponse?.[0];
  if (!res.ok || attachable?.Fault) {
    const detail = attachable?.Fault?.Error?.[0] || body?.Fault?.Error?.[0];
    const tid = res.headers.get('intuit_tid');
    throw new Error(`QuickBooks attachment error ${res.status}: ${detail?.Message || ''} ${detail?.Detail || ''}${tid ? ` [intuit_tid ${tid}]` : ''}`.trim());
  }
  return { attachableId: attachable?.Attachable?.Id, fileName };
}
