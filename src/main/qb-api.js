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
// sheet (docs/System Code.xlsx, received 2026-07-09). ITDE and TOEQ are not on
// the sheet but appear on real KAR PRs (ITDE: #28961, #33582; TOEQ: #33114);
// Purchase - IT and Purchase - Misc are the assumed targets pending Alan's
// confirmation.
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
  TOEQ: 'Purchase - Misc',
  TOOL: 'Purchase - Misc',
};

export const DEFAULT_ACCOUNT_NAME = 'Purchase - Misc';

// Blue Rock's books already contain a vendor literally named UNKNOWN, used as
// the placeholder when the market supplier can't be identified (handwritten
// invoices). Bills default to it; the team reassigns the real supplier in QBO.
export const PLACEHOLDER_VENDOR_NAME = 'UNKNOWN';

const round2 = (n) => Math.round(n * 100) / 100;

/** Reviewer-entered unit cost x qty; 0 when no cost was entered (legacy $0 flow). */
function lineCost(li) {
  if (li.unit_cost == null || !(li.qty > 0)) return 0;
  return round2(li.unit_cost * li.qty);
}

/** Effective margin % for a line: per-line override, else the settings default. */
function lineMarginPct(li, qb) {
  const m = li.margin_pct ?? qb.defaultMarginPct;
  return Number.isFinite(Number(m)) ? Number(m) : 0;
}

/** Build the QBO Bill payload from a reviewed extraction. */
export function buildBillPayload(extraction, qb) {
  const serviceTicket = (extraction.service_ticket || '').trim();
  const lines = (extraction.line_items || []).map((li) => {
    const prefix = (li.sage_code || '').split('-')[0];
    const accountId = qb.accountMap?.[prefix] || qb.defaultAccountId || '';
    return {
      DetailType: 'AccountBasedExpenseLineDetail',
      // Reviewer-entered unit cost x qty; lines without a cost land at 0.00
      // in review-pending state and the team completes them in QBO.
      Amount: lineCost(li),
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
      serviceTicket ? `Service Ticket: ${serviceTicket}` : null,
      extraction.note ? `Note: ${extraction.note}` : null,
    ].filter(Boolean).join(' | ').slice(0, 4000),
    Line: lines,
  };
}

/**
 * Build the QBO Invoice payload (receivable to KAR) from a reviewed extraction,
 * matching Blue Rock's invoice template: PO # / Service Ticket / Location
 * custom fields, the line's Sage code as the Product/Service item, Net 30
 * terms, and the standard wire-transfer instructions as the message on the
 * invoice. Line price = unit cost x (1 + margin%). QBO assigns the invoice
 * number from the company's own AR sequence (no DocNumber sent).
 */
export function buildInvoicePayload(extraction, qb) {
  const prefix = extraction.doc_type === 'service_request' ? 'SR' : 'PR';
  const serviceTicket = (extraction.service_ticket || '').trim();
  const lines = (extraction.line_items || []).map((li) => {
    const qty = li.qty > 0 ? li.qty : 1;
    const unitPrice = round2((li.unit_cost || 0) * (1 + lineMarginPct(li, qb) / 100));
    // Product/Service column shows the line's Sage code (an Item auto-created
    // per code, cached in qb.itemMap); lines without a code fall back to the
    // generic invoice item.
    const itemId = (li.sage_code && qb.itemMap?.[li.sage_code]) || qb.invoiceItemId;
    return {
      DetailType: 'SalesItemLineDetail',
      Amount: round2(unitPrice * qty),
      Description: [
        li.description,
        li.purpose,
      ].filter(Boolean).join(' | ').slice(0, 4000),
      SalesItemLineDetail: {
        ItemRef: { value: String(itemId) },
        Qty: qty,
        UnitPrice: unitPrice,
      },
    };
  });

  // Template custom fields. QBO caps custom field values at 31 characters.
  const cf = (id, name, value) => ({ DefinitionId: String(id), Name: name, Type: 'StringType', StringValue: value.slice(0, 31) });
  const customFields = [];
  if (extraction.number && qb.poFieldId) {
    customFields.push(cf(qb.poFieldId, qb.poFieldName || 'PO #', String(extraction.number)));
  }
  if (serviceTicket && qb.serviceTicketFieldId) {
    customFields.push(cf(qb.serviceTicketFieldId, qb.serviceTicketFieldName || 'Service Ticket', serviceTicket));
  }
  if (extraction.project_site && qb.locationFieldId) {
    customFields.push(cf(qb.locationFieldId, qb.locationFieldName || 'Location', extraction.project_site));
  }

  return {
    CustomerRef: { value: String(qb.customerId), name: qb.customerName || undefined },
    // Invoice is dated when it's raised, not when KAR raised the request.
    TxnDate: new Date().toISOString().slice(0, 10),
    SalesTermRef: qb.invoiceTermId ? { value: String(qb.invoiceTermId) } : undefined,
    // "Message on invoice" — the standard wire-transfer instructions (falls
    // back to the KAR reference if the message is cleared in Settings).
    CustomerMemo: { value: ((qb.invoiceMessage || '').trim() || `KAR ${prefix === 'SR' ? 'Service' : 'Purchase'} Request #${extraction.number || '?'}`).slice(0, 1000) },
    // No PrivateNote: it maps to the invoice's "Message on statement", which
    // Blue Rock wants left blank (the PR/SR cross-reference lives in the PO #
    // custom field and on the bill's memo instead).
    CustomField: customFields.length ? customFields : undefined,
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

export async function qbPost(mode, accessToken, realmId, entity, payload) {
  const res = await fetch(`${apiBase(mode)}/v3/company/${realmId}/${entity}?minorversion=75`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.Fault?.Error?.[0];
    const tid = res.headers.get('intuit_tid');
    throw new Error(`QuickBooks error ${res.status}: ${detail?.Message || ''} ${detail?.Detail || ''}${tid ? ` [intuit_tid ${tid}]` : ''}`.trim());
  }
  return body;
}

const escQ = (s) => String(s).replace(/'/g, "\\'");

/**
 * Resolve what the Invoice payload needs: the KAR customer Id (looked up from
 * customerName when the Id isn't set) and the Product/Service item invoice
 * lines must reference (looked up by invoiceItemName; created as a Service item
 * on the company's first income account if it doesn't exist yet). Returns a
 * partial qb-settings patch with the resolved Ids, or throws with a message
 * that tells the user exactly which Settings field to fix.
 *
 * When the document carries a Service Ticket value (opts.needServiceTicket),
 * also resolve which of the company's classic sales custom fields (DefinitionId
 * 1-3) is labelled serviceTicketFieldName, from Preferences.SalesFormsPrefs.
 * Only resolved when actually needed, so pushes without a ticket never fail on
 * a company whose invoice form lacks the field.
 */
export async function resolveInvoiceRefs(mode, accessToken, realmId, qb, opts = {}) {
  const patch = {};

  if (!qb.customerId) {
    if (!qb.customerName) throw new Error('Invoice customer not set (Settings > QuickBooks > Invoice customer name)');
    const customers = (await query(mode, accessToken, realmId,
      `select Id, DisplayName from Customer where DisplayName = '${escQ(qb.customerName)}'`)).Customer || [];
    if (!customers.length) {
      throw new Error(`No QuickBooks customer named "${qb.customerName}" — check Settings > QuickBooks > Invoice customer name against the company's customer list`);
    }
    patch.customerId = String(customers[0].Id);
    patch.customerName = customers[0].DisplayName;
  }

  // Service items are created on the company's first income account; look it
  // up once per resolve, only when something actually needs creating.
  let incomeAccountId = null;
  const firstIncomeAccount = async () => {
    if (incomeAccountId) return incomeAccountId;
    const income = (await query(mode, accessToken, realmId,
      "select Id, Name from Account where AccountType = 'Income' maxresults 1")).Account || [];
    if (!income.length) throw new Error('Could not create an invoice item: the company has no income account');
    incomeAccountId = String(income[0].Id);
    return incomeAccountId;
  };
  const createServiceItem = async (name) => {
    const created = await qbPost(mode, accessToken, realmId, 'item', {
      Name: name,
      Type: 'Service',
      IncomeAccountRef: { value: await firstIncomeAccount() },
    });
    return String(created.Item?.Id);
  };

  if (!qb.invoiceItemId) {
    const itemName = qb.invoiceItemName || 'KAR Procurement';
    const items = (await query(mode, accessToken, realmId,
      `select Id, Name from Item where Name = '${escQ(itemName)}'`)).Item || [];
    patch.invoiceItemId = items.length ? String(items[0].Id) : await createServiceItem(itemName);
    patch.invoiceItemName = itemName;
  }

  // Product/Service column shows each line's Sage code — one Service item per
  // distinct code, looked up (or created) once and cached in qb.itemMap.
  const newCodes = [...new Set(opts.sageCodes || [])].filter((c) => c && !qb.itemMap?.[c]);
  if (newCodes.length) {
    const itemMap = {};
    const nameList = newCodes.map((c) => `'${escQ(c)}'`).join(', ');
    const found = (await query(mode, accessToken, realmId,
      `select Id, Name from Item where Name in (${nameList})`)).Item || [];
    for (const it of found) itemMap[it.Name] = String(it.Id);
    for (const code of newCodes) {
      if (!itemMap[code]) itemMap[code] = await createServiceItem(code);
    }
    patch.itemMap = itemMap; // deep-merged into the existing cache on save
  }

  if (!qb.invoiceTermId && qb.invoiceTermName) {
    // Best-effort: without a match, QBO falls back to the customer/company
    // default terms — not worth failing the push over.
    const terms = (await query(mode, accessToken, realmId,
      `select Id, Name from Term where Name = '${escQ(qb.invoiceTermName)}'`)).Term || [];
    if (terms.length) patch.invoiceTermId = String(terms[0].Id);
  }

  const needPo = !!(qb.poFieldName && !qb.poFieldId);
  const needLocation = !!(qb.locationFieldName && !qb.locationFieldId);
  const needTicket = !!(opts.needServiceTicket && !qb.serviceTicketFieldId);
  if (needPo || needLocation || needTicket) {
    const seen = new Map(); // label -> DefinitionId

    // Companies on the classic custom-fields experience expose the labels via
    // Preferences: SalesFormsPrefs.CustomField groups hold entries named
    // SalesFormsPrefs.SalesCustomName1..3 — the trailing digit is the
    // DefinitionId invoices reference.
    const prefs = await qbGet(mode, accessToken, `/v3/company/${realmId}/preferences?minorversion=75`);
    const groups = prefs?.Preferences?.SalesFormsPrefs?.CustomField || [];
    for (const f of groups.flatMap((g) => g.CustomField || [])) {
      if (/^SalesFormsPrefs\.SalesCustomName\d$/.test(f.Name || '') && f.StringValue) {
        seen.set(f.StringValue.trim(), f.Name.slice(-1));
      }
    }

    const lookup = (name) => {
      const lc = (name || '').trim().toLowerCase();
      return [...seen.entries()].find(([label]) => label.toLowerCase() === lc);
    };

    // Companies migrated to QBO's NEW custom-fields experience return nothing
    // through Preferences — but existing invoices still carry the fields with
    // their DefinitionIds, so scan recent invoices for the labels.
    if ((needTicket && !lookup(qb.serviceTicketFieldName || 'Service Ticket'))
      || (needPo && !lookup(qb.poFieldName)) || (needLocation && !lookup(qb.locationFieldName))) {
      const invoices = (await query(mode, accessToken, realmId,
        'select * from Invoice orderby MetaData.LastUpdatedTime desc maxresults 30')).Invoice || [];
      for (const inv of invoices) {
        for (const cf of inv.CustomField || []) {
          if (cf.Name && cf.DefinitionId != null && !seen.has(cf.Name.trim())) {
            seen.set(cf.Name.trim(), String(cf.DefinitionId));
          }
        }
      }
    }

    // PO # and Location are best-effort: a company without them (sandbox)
    // just gets an invoice without those fields. The Service Ticket is strict
    // — the reviewer typed a value expecting it to land on the invoice.
    if (needPo) {
      const hit = lookup(qb.poFieldName);
      if (hit) { patch.poFieldId = hit[1]; patch.poFieldName = hit[0]; }
    }
    if (needLocation) {
      const hit = lookup(qb.locationFieldName);
      if (hit) { patch.locationFieldId = hit[1]; patch.locationFieldName = hit[0]; }
    }
    if (needTicket) {
      const label = (qb.serviceTicketFieldName || 'Service Ticket').trim();
      const hit = lookup(label);
      if (!hit) {
        const have = [...seen.keys()].map((n) => `"${n}"`).join(', ');
        throw new Error(`No custom field labelled "${label}" found on the QuickBooks invoice form${have ? ` (fields seen: ${have})` : ' (none found via Preferences or the company\'s recent invoices)'} — fix Settings > QuickBooks > Service ticket field name, type the field Id (1, 2 or 3) into Service ticket field Id directly, or clear the document's Service ticket box`);
      }
      patch.serviceTicketFieldId = hit[1];
      patch.serviceTicketFieldName = hit[0];
    }
  }

  return patch;
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
export async function uploadAttachment(mode, accessToken, realmId, billId, filePath, displayName) {
  // Show the original filename in QBO, not the internal storage name —
  // extension must stay true to the stored file's actual type.
  const fileName = displayName && path.extname(displayName).toLowerCase() === path.extname(filePath).toLowerCase()
    ? displayName
    : path.basename(filePath);
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
