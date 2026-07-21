// Optional Google Drive archival (off by default — the app is fully functional without it).
// Uses the OAuth "Desktop app" loopback flow with the drive.file scope (the app can only
// see files/folders it created) plus the spreadsheets scope for the tracking-sheet
// integration (sheets.js) — fine without Google verification because Blue Rock's consent
// screen is Internal to their Workspace. NOTE for setup: the Google Cloud OAuth consent
// screen must be "In production" — in "Testing" status refresh tokens expire after
// 7 days and archival silently stops. (Doesn't apply to Internal consent screens.)
import { shell } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getSettings, saveSettings } from './settings.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// The loopback listener from an abandoned connect attempt (browser closed,
// consent cancelled) would otherwise hold the port for the full 5-minute
// timeout and make an immediate retry fail with EADDRINUSE.
let pendingOauthServer = null;

export async function startDriveConnect() {
  if (pendingOauthServer) {
    try { pendingOauthServer.close(); } catch { /* already closed */ }
    pendingOauthServer = null;
  }
  const drive = getSettings().drive;
  // Defensive trim — older saved settings may carry pasted whitespace.
  drive.clientId = (drive.clientId || '').trim();
  drive.clientSecret = (drive.clientSecret || '').trim();
  if (!drive.clientId || !drive.clientSecret) throw new Error('Google Drive Client ID / Secret not set');
  const port = Number(drive.redirectPort) || 8124;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = crypto.randomBytes(12).toString('hex');

  const authUrl = `${AUTH_URL}?` + new URLSearchParams({
    client_id: drive.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    // select_account: always show the account chooser — the default browser is
    // usually signed into personal accounts, and the archive must land on the
    // dedicated mailbox account (an Internal app 400s for outside-org accounts).
    prompt: 'consent select_account',
    state,
  });

  return await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, redirectUri);
        if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
        if (url.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
        const code = url.searchParams.get('code');
        const tokenRes = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: drive.clientId,
            client_secret: drive.clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
        });
        const json = await tokenRes.json();
        if (!tokenRes.ok) throw new Error('Drive token exchange failed: ' + JSON.stringify(json).slice(0, 200));
        saveSettings({
          drive: {
            tokens: {
              access_token: json.access_token,
              refresh_token: json.refresh_token,
              expires_at: Date.now() + (json.expires_in || 3600) * 1000,
              // What was actually granted — connections made before the
              // tracking-sheet feature lack the spreadsheets scope and need a
              // one-time reconnect (surfaced in Settings via driveStatus).
              scope: json.scope || SCOPE,
            },
          },
        });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Connected to Google Drive.</h2>You can close this tab.');
        server.close();
        pendingOauthServer = null;
        resolve({ connected: true });
      } catch (err) {
        res.writeHead(500).end('OAuth error: ' + err.message);
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

/** Bearer token for Google APIs (Drive + Sheets share the one connection). */
export async function driveAccessToken() {
  return accessToken();
}

async function accessToken() {
  const drive = getSettings().drive;
  const t = drive.tokens;
  if (!t?.refresh_token) throw new Error('Not connected to Google Drive');
  if (t.access_token && Date.now() < (t.expires_at || 0) - 60_000) return t.access_token;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: drive.clientId,
      client_secret: drive.clientSecret,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Drive token refresh failed — reconnect in Settings');
  const tokens = { ...t, access_token: json.access_token, expires_at: Date.now() + (json.expires_in || 3600) * 1000 };
  saveSettings({ drive: { tokens } });
  return tokens.access_token;
}

async function driveFetch(url, opts = {}) {
  const token = await accessToken();
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function ensureFolder(name, parentId) {
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ].join(' and ');
  const list = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
  if (list.files?.length) return list.files[0].id;
  const created = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    }),
  });
  return created.id;
}

function multipartBody(metadata, mime, buffer) {
  const boundary = 'bluerock' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  return { body: Buffer.concat([head, buffer, tail]), boundary };
}

/**
 * Archive a processed document: original file + extraction JSON under
 * /<root>/<Service Ticket>/ when the order has an ST number (Blue Rock files
 * orders by ST), else /<root>/<Department>/<YYYY-MM>/.
 */
export async function archiveToDrive(doc, settings) {
  const drive = settings.drive;
  const ex = doc.extraction || {};
  const baseName = ex.number
    ? `${ex.doc_type === 'service_request' ? 'SR' : 'PR'}-${ex.number}`
    : doc.fileName.replace(/\.[^.]+$/, '');

  const rootId = await ensureFolder(drive.rootFolderName || 'KAR', null);
  const st = (ex.service_ticket || '').trim().replace(/[\\/:*?"<>|]/g, '-');
  let parentId;
  let subPath;
  if (st) {
    parentId = await ensureFolder(st, rootId);
    subPath = st;
  } else {
    const dept = (ex.department || 'Unsorted').replace(/[\\/:*?"<>|]/g, '-');
    const iso = (ex.date || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const yearMonth = iso ? `${iso[3]}-${iso[2]}` : new Date().toISOString().slice(0, 7);
    const deptId = await ensureFolder(dept, rootId);
    parentId = await ensureFolder(yearMonth, deptId);
    subPath = `${dept}/${yearMonth}`;
  }

  const ext = doc.fileName.includes('.') ? doc.fileName.slice(doc.fileName.lastIndexOf('.')) : '';
  const fileBuf = fs.readFileSync(doc.filePath);
  const up1 = multipartBody({ name: baseName + ext, parents: [parentId] }, doc.mime, fileBuf);
  const f1 = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${up1.boundary}` },
    body: up1.body,
  });

  const jsonBuf = Buffer.from(JSON.stringify(ex, null, 2));
  const up2 = multipartBody({ name: baseName + '.json', parents: [parentId] }, 'application/json', jsonBuf);
  await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${up2.boundary}` },
    body: up2.body,
  });

  return { fileId: f1.id, link: f1.webViewLink, path: `${drive.rootFolderName || 'KAR'}/${subPath}/${baseName}${ext}` };
}

export function driveStatus() {
  const drive = getSettings().drive;
  return {
    enabled: !!drive.enabled,
    connected: !!drive.tokens?.refresh_token,
    // False for connections made before the tracking-sheet feature (their
    // token predates the spreadsheets scope) — Settings prompts a reconnect.
    sheetsReady: !!(drive.tokens?.scope || '').includes('/spreadsheets'),
  };
}
