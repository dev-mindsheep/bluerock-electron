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

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

function apiBase(mode) {
  return mode === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function toIsoDate(ddmmyyyy) {
  const m = (ddmmyyyy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return new Date().toISOString().slice(0, 10);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Build the QBO Bill payload from a reviewed extraction. */
export function buildBillPayload(extraction, qb) {
  const lines = (extraction.line_items || []).map((li, i) => {
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

/** Push a reviewed document to QuickBooks (or the mock outbox). */
export async function pushToQuickBooks(doc, settings) {
  const qb = settings.qb;
  const payload = buildBillPayload(doc.extraction, qb);

  if (qb.mode === 'mock') {
    const dir = path.join(app.getPath('userData'), 'qb-outbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${payload.DocNumber || doc.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), payload }, null, 2));
    return { mock: true, billId: `MOCK-${(payload.DocNumber || doc.id)}`, docNumber: payload.DocNumber, payloadPath: file };
  }

  if (!qb.vendorId) throw new Error('QuickBooks Vendor Id not set (Settings > QuickBooks)');
  const accessToken = await getAccessToken(qb);
  const realmId = qb.tokens?.realmId;
  if (!realmId) throw new Error('Not connected to QuickBooks — run Connect first');

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
    throw new Error(`QuickBooks error ${res.status}: ${detail?.Message || ''} ${detail?.Detail || ''}`.trim());
  }
  return { mock: false, billId: body.Bill?.Id, docNumber: payload.DocNumber };
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
  if (!res.ok) throw new Error(`QuickBooks token refresh failed (${res.status}) — reconnect in Settings`);
  const tokens = {
    ...t,
    access_token: json.access_token,
    refresh_token: json.refresh_token, // rotates — MUST persist
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
  };
  saveSettings({ qb: { tokens } });
  return tokens.access_token;
}

/**
 * Start the OAuth connect flow.
 * Sandbox: full loopback flow on http://localhost:<port>/callback.
 * Production: Intuit requires an HTTPS redirect — we open the browser with the
 * configured redirect and the user pastes back code+realmId via finishConnectManual().
 */
export async function startConnect() {
  const settings = getSettings();
  const qb = settings.qb;
  if (!qb.clientId || !qb.clientSecret) throw new Error('QuickBooks Client ID / Secret not set');
  const state = crypto.randomBytes(12).toString('hex');
  const port = Number(qb.redirectPort) || 8123;
  const redirectUri = `http://localhost:${port}/callback`;

  const authUrl = `${AUTH_URL}?` + new URLSearchParams({
    client_id: qb.clientId,
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  });

  if (qb.mode === 'production') {
    // Loopback is rejected for production apps; open auth URL with localhost anyway
    // is not allowed — so we just surface the URL and expect the manual paste flow
    // against the registered HTTPS redirect page.
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
        resolve({ connected: true, realmId });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('OAuth error: ' + err.message);
        server.close();
        reject(err);
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => shell.openExternal(authUrl));
    setTimeout(() => { try { server.close(); } catch {} reject(new Error('OAuth timed out after 5 minutes')); }, 5 * 60_000).unref();
  });
}

/** Production fallback: user pastes ?code=...&realmId=... from the HTTPS callback page. */
export async function finishConnectManual({ code, realmId, redirectUri }) {
  const qb = getSettings().qb;
  await exchangeCode(qb, code, redirectUri, realmId);
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
}

export function qbStatus() {
  const qb = getSettings().qb;
  return {
    mode: qb.mode,
    connected: !!qb.tokens?.refresh_token,
    realmId: qb.tokens?.realmId || null,
  };
}
