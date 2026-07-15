// QuickBooks Online integration.
// - mock mode (default): writes the exact Bill payload to userData/qb-outbox/<id>.json
//   so the flow can be demonstrated and inspected before an Intuit developer app exists.
// - sandbox/production: OAuth2 (loopback redirect for sandbox; paste-the-code flow for
//   production, whose redirect URI must be public HTTPS per Intuit policy) + Bill create.
// Refresh tokens ROTATE on every refresh and last ~100 days — always persist the new one.
import { app, shell } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSettings, saveSettings } from './settings.js';
import { apiBase, buildBillPayload, buildInvoicePayload, listVendors, qbPost, resolveCompanyIds, resolveInvoiceRefs, uploadAttachment } from './qb-api.js';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

export { buildBillPayload } from './qb-api.js';

/** Push a reviewed document to QuickBooks (or the mock outbox). */
export async function pushToQuickBooks(doc, settings) {
  const qb = settings.qb;
  const payload = buildBillPayload(doc.extraction, qb);
  // Reviewer-chosen vendor on this document overrides the placeholder default.
  if (doc.vendorId) {
    payload.VendorRef = { value: String(doc.vendorId), name: doc.vendorName || undefined };
  }

  // Fail before anything is created: an invoice without a unit cost on every
  // line would bill KAR wrong numbers, so the reviewer must finish pricing
  // first (or invoicing must be turned off in Settings).
  if (qb.createInvoice) {
    const unpriced = (doc.extraction.line_items || [])
      .map((li, i) => (li.unit_cost == null ? i + 1 : null))
      .filter(Boolean);
    if (unpriced.length) {
      throw new Error(`Line ${unpriced.join(', ')} has no unit cost — enter costs on the review screen, or untick "Create KAR invoice" in Settings`);
    }
  }

  if (qb.mode === 'mock') {
    const dir = path.join(app.getPath('userData'), 'qb-outbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${payload.DocNumber || doc.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), payload }, null, 2));
    let invoiceId = null;
    if (qb.createInvoice) {
      const invoicePayload = buildInvoicePayload(doc.extraction, { ...qb, customerId: qb.customerId || 'MOCK', invoiceItemId: qb.invoiceItemId || 'MOCK', serviceTicketFieldId: qb.serviceTicketFieldId || 'MOCK' });
      fs.writeFileSync(path.join(dir, `${payload.DocNumber || doc.id}-invoice.json`),
        JSON.stringify({ createdAt: new Date().toISOString(), payload: invoicePayload }, null, 2));
      invoiceId = `MOCK-INV-${payload.DocNumber || doc.id}`;
    }
    return { mock: true, billId: `MOCK-${(payload.DocNumber || doc.id)}`, docNumber: payload.DocNumber, payloadPath: file, invoiceId, invoiceDocNumber: invoiceId };
  }

  if (!doc.vendorId && !qb.vendorId) throw new Error('No vendor: pick one on the review screen, or connect to QuickBooks so the placeholder vendor resolves (Settings > QuickBooks)');
  const accessToken = await getAccessToken(qb);
  const realmId = qb.tokens?.realmId;
  if (!realmId) throw new Error('Not connected to QuickBooks — run Connect first');

  // Resolve the invoice's customer + item BEFORE creating the bill, so a
  // misconfigured invoice setting fails the push cleanly instead of leaving a
  // bill behind with no invoice. Resolved Ids persist for later pushes.
  let invoiceQb = null;
  if (qb.createInvoice) {
    const refsPatch = await resolveInvoiceRefs(qb.mode, accessToken, realmId, qb,
      { needServiceTicket: !!(doc.extraction.service_ticket || '').trim() });
    if (Object.keys(refsPatch).length) saveSettings({ qb: refsPatch });
    invoiceQb = { ...qb, ...refsPatch };
  }

  const res = await fetch(`${apiBase(qb.mode)}/v3/company/${realmId}/bill?minorversion=75`, {
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
  const billId = body.Bill?.Id;

  // Attach the original source document to the bill. The bill exists at this
  // point, so an attachment failure must not fail the push — surface it instead.
  let attachment = null;
  let attachmentError = null;
  if (billId && doc.filePath && fs.existsSync(doc.filePath)) {
    try {
      attachment = await uploadAttachment(qb.mode, accessToken, realmId, billId, doc.filePath, doc.fileName);
    } catch (err) {
      attachmentError = err.message;
    }
  }

  // Invoice to KAR (cost + margin). The bill exists at this point, so an
  // invoice failure must not fail the push — surface it so the reviewer can
  // raise the invoice in QBO by hand.
  let invoiceId = null;
  let invoiceDocNumber = null;
  let invoiceError = null;
  if (invoiceQb) {
    try {
      const body = await qbPost(qb.mode, accessToken, realmId, 'invoice', buildInvoicePayload(doc.extraction, invoiceQb));
      invoiceId = body.Invoice?.Id;
      invoiceDocNumber = body.Invoice?.DocNumber;
    } catch (err) {
      invoiceError = err.message;
    }
  }

  return { mock: false, billId, docNumber: payload.DocNumber, attachment, attachmentError, invoiceId, invoiceDocNumber, invoiceError };
}

// ---------------- OAuth ----------------

async function getAccessToken(qb) {
  const t = qb.tokens;
  if (!t?.refresh_token) throw new Error('Not connected to QuickBooks — run Connect first');
  if (t.access_token && t.expires_at && Date.now() < t.expires_at - 60_000) {
    return t.access_token;
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${qb.clientId}:${qb.clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const tid = res.headers.get('intuit_tid');
    throw new Error(`QuickBooks token refresh failed (${res.status}) — reconnect in Settings${tid ? ` [intuit_tid ${tid}]` : ''}`);
  }
  const tokens = {
    ...t,
    access_token: json.access_token,
    refresh_token: json.refresh_token, // rotates — MUST persist
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
  };
  saveSettings({ qb: { tokens } });
  return tokens.access_token;
}

// The loopback listener from an abandoned connect attempt (browser closed,
// Intuit errored before redirecting) would otherwise hold the port for the
// full 5-minute timeout and make an immediate retry fail with EADDRINUSE.
let pendingOauthServer = null;

/**
 * Start the OAuth connect flow.
 * Sandbox: full loopback flow on http://localhost:<port>/callback.
 * Production: Intuit requires an HTTPS redirect — we open the browser with the
 * configured redirect and the user pastes back code+realmId via finishConnectManual().
 */
export async function startConnect() {
  if (pendingOauthServer) {
    try { pendingOauthServer.close(); } catch { /* already closed */ }
    pendingOauthServer = null;
  }
  const settings = getSettings();
  const qb = settings.qb;
  // Defensive trim — older saved settings may carry pasted whitespace.
  qb.clientId = (qb.clientId || '').trim();
  qb.clientSecret = (qb.clientSecret || '').trim();
  if (!qb.clientId || !qb.clientSecret) throw new Error('QuickBooks Client ID / Secret not set');
  const state = crypto.randomBytes(12).toString('hex');
  const port = Number(qb.redirectPort) || 8123;
  // Intuit rejects localhost redirects on production apps — the auth URL must
  // carry the registered HTTPS redirect there; sandbox uses the local loopback.
  const redirectUri = qb.mode === 'production'
    ? qb.productionRedirectUri
    : `http://localhost:${port}/callback`;
  if (qb.mode === 'production' && !redirectUri) {
    throw new Error('Production redirect URI not set (Settings > QuickBooks)');
  }

  const authUrl = `${AUTH_URL}?` + new URLSearchParams({
    client_id: qb.clientId,
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  });

  if (qb.mode === 'production') {
    // The browser lands on the registered HTTPS callback page, which displays
    // code + realmId for the user to paste back via finishConnectManual().
    await shell.openExternal(authUrl);
    return { manual: true, message: 'Production mode: complete sign-in in the browser, then paste the code and realmId from the callback page into Settings > QuickBooks > Manual code.' };
  }

  return await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
        if (url.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
        const code = url.searchParams.get('code');
        const realmId = url.searchParams.get('realmId');
        await exchangeCode(qb, code, redirectUri, realmId);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Connected to QuickBooks.</h2>You can close this tab and return to the app.');
        server.close();
        pendingOauthServer = null;
        resolve({ connected: true, realmId });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('OAuth error: ' + err.message);
        server.close();
        pendingOauthServer = null;
        reject(err);
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => shell.openExternal(authUrl));
    pendingOauthServer = server;
    setTimeout(() => { try { server.close(); } catch {} if (pendingOauthServer === server) pendingOauthServer = null; reject(new Error('OAuth timed out after 5 minutes')); }, 5 * 60_000).unref();
  });
}

/** Production fallback: user pastes ?code=...&realmId=... from the HTTPS callback page. */
export async function finishConnectManual({ code, realmId, redirectUri }) {
  const qb = getSettings().qb;
  await exchangeCode(qb, code, redirectUri || qb.productionRedirectUri, realmId);
  return { connected: true, realmId };
}

async function exchangeCode(qb, code, redirectUri, realmId) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${qb.clientId}:${qb.clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`QuickBooks code exchange failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
  saveSettings({
    qb: {
      tokens: {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: Date.now() + (json.expires_in || 3600) * 1000,
        realmId,
      },
    },
  });

  // Fill empty accountMap / default-account / placeholder-vendor Ids by looking
  // up their known names in the freshly connected company. Best-effort: on a
  // sandbox company (US chart of accounts) most names won't exist, and manual
  // values entered in Settings are never overwritten.
  try {
    const { qbPatch, unresolved } = await resolveCompanyIds(qb.mode, json.access_token, realmId, getSettings().qb);
    saveSettings({ qb: qbPatch });
    if (unresolved.length) console.warn('[qb] unresolved after connect:', unresolved.join('; '));
  } catch (err) {
    console.warn('[qb] post-connect Id resolution failed:', err.message);
  }
}

/** Vendor list for the review screen's picker. Mock mode has no company to query. */
export async function fetchVendors() {
  const qb = getSettings().qb;
  if (qb.mode === 'mock' || !qb.tokens?.refresh_token) return [];
  const accessToken = await getAccessToken(qb);
  return listVendors(qb.mode, accessToken, qb.tokens.realmId);
}

export function qbStatus() {
  const qb = getSettings().qb;
  return {
    mode: qb.mode,
    connected: !!qb.tokens?.refresh_token,
    realmId: qb.tokens?.realmId || null,
  };
}
