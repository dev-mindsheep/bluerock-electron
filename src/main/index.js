// Blue Rock Procurement — Electron main process
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSettings, saveSettings } from './settings.js';
import { logError, logFilePath } from './log.js';
import * as store from './store.js';
import { ingestFile } from './intake.js';
import { checkEmail } from './email.js';
import { runExtraction } from './extract/index.js';
import { pushToQuickBooks, startConnect, finishConnectManual, qbStatus, fetchVendors } from './quickbooks.js';
import { startDriveConnect, archiveToDrive, driveStatus } from './drive.js';
import { allocateTicket, recordPushInTracking, trackingMeta } from './sheets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win = null;
let pollTimer = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Blue Rock Procurement',
    backgroundColor: '#12161c',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.removeMenu?.();
  // Links (mailto:, https:) open in the OS default handler, never in-window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function notifyDocsChanged() {
  win?.webContents.send('docs:changed');
}
function notifyStatus(message, level = 'info') {
  win?.webContents.send('app:status', { message, level, at: new Date().toISOString() });
}

// ---- email polling ----
function restartPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  const s = getSettings();
  if (!s.email.enabled) return;
  const minutes = Math.max(1, Number(s.general.pollMinutes) || 5);
  pollTimer = setInterval(async () => {
    try {
      const { added } = await checkEmail(getSettings());
      if (added > 0) {
        notifyDocsChanged();
        notifyStatus(`Email check: ${added} new document(s) added to the queue`);
      }
    } catch (err) {
      notifyStatus(`Email check failed: ${err.message}`, 'error');
    }
  }, minutes * 60_000);
}

// ---- IPC ----
const ok = (data) => ({ ok: true, data });
const fail = (err) => ({ ok: false, error: err?.message || String(err) });

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return ok(await fn(...args));
    } catch (err) {
      console.error(`[${channel}]`, err);
      logError(channel, err);
      return fail(err);
    }
  });
}

handle('logs:open', () => { shell.showItemInFolder(logFilePath()); return true; });

handle('settings:get', () => getSettings());
handle('settings:set', (patch) => {
  const merged = saveSettings(patch);
  restartPolling();
  return merged;
});

handle('docs:list', () => store.listDocuments());
handle('docs:get', (id) => store.getDocument(id));
handle('docs:add-files', async (paths) => {
  let added = 0;
  const errors = [];
  for (const p of paths) {
    try {
      const docs = await ingestFile({ sourcePath: p, fileName: path.basename(p), source: 'drop' });
      added += docs.length;
    } catch (err) {
      errors.push(`${path.basename(p)}: ${err.message}`);
    }
  }
  notifyDocsChanged();
  return { added, errors };
});
handle('docs:pick-files', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Documents', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp'] }],
  });
  if (res.canceled) return { added: 0, errors: [] };
  const out = { added: 0, errors: [] };
  for (const p of res.filePaths) {
    try {
      const docs = await ingestFile({ sourcePath: p, fileName: path.basename(p), source: 'drop' });
      out.added += docs.length;
    } catch (err) {
      out.errors.push(`${path.basename(p)}: ${err.message}`);
    }
  }
  notifyDocsChanged();
  return out;
});
handle('docs:update-extraction', (id, extraction) => {
  const doc = store.updateDocument(id, { extraction });
  notifyDocsChanged();
  return doc;
});
handle('docs:set-vendor', (id, vendor) => {
  const doc = store.updateDocument(id, { vendorId: vendor?.vendorId || null, vendorName: vendor?.vendorName || null });
  notifyDocsChanged();
  return doc;
});
handle('docs:set-status', (id, status) => {
  const doc = store.updateDocument(id, { status });
  notifyDocsChanged();
  return doc;
});
handle('docs:delete', (id) => {
  const res = store.deleteDocument(id);
  notifyDocsChanged();
  return res;
});
handle('docs:file-url', (id) => {
  const doc = store.getDocument(id);
  if (!doc) throw new Error('Document not found');
  return pathToFileURL(doc.filePath).href;
});

handle('extract:run', async (id) => {
  const doc = store.getDocument(id);
  if (!doc) throw new Error('Document not found');
  store.updateDocument(id, { status: 'extracting', error: null });
  notifyDocsChanged();
  try {
    const extraction = await runExtraction(doc, getSettings());
    const updated = store.updateDocument(id, { status: 'extracted', extraction });
    notifyDocsChanged();
    return updated;
  } catch (err) {
    store.updateDocument(id, { status: 'error', error: err.message });
    notifyDocsChanged();
    throw err;
  }
});

handle('email:check-now', async () => {
  const res = await checkEmail(getSettings());
  notifyDocsChanged();
  return res;
});

handle('qb:push', async (id) => {
  const doc = store.getDocument(id);
  if (!doc?.extraction) throw new Error('Document has no reviewed extraction');
  const settings = getSettings();
  const result = await pushToQuickBooks(doc, settings);
  // A multi-supplier push can partially fail (some bills created, some not).
  // The document then stays re-pushable: the next push retries only the
  // missing bills, and archival waits for the full set.
  const complete = !(result.billErrors || []).length;
  let driveFile = doc.driveFile;
  if (complete && settings.drive.enabled && settings.drive.tokens?.refresh_token) {
    try {
      driveFile = await archiveToDrive(doc, settings);
    } catch (err) {
      notifyStatus(`Drive archive failed (entry was still pushed): ${err.message}`, 'error');
    }
  }
  // Complete the order's row in the Blue Rock tracking sheet (status, QB
  // invoice number, bill register). Non-fatal like Drive archival — the push
  // stands, and the review screen offers a retry.
  let sheetSync = doc.sheetSync || null;
  if (complete && settings.drive.trackingEnabled) {
    try {
      sheetSync = { ok: true, at: new Date().toISOString(), ...(await recordPushInTracking({ ...doc, qb: result })) };
    } catch (err) {
      sheetSync = { ok: false, at: new Date().toISOString(), error: err.message };
      notifyStatus(`Tracking sheet update failed (entry was still pushed): ${err.message}`, 'error');
    }
  }
  const updated = store.updateDocument(id, {
    status: complete ? 'pushed' : 'extracted',
    error: complete ? null
      : `${result.billErrors.length} of ${result.bills.length + result.billErrors.length} bills failed — open the document and push again to retry the failed ones`,
    qb: { ...result, pushedAt: complete ? new Date().toISOString() : doc.qb?.pushedAt || null },
    driveFile,
    sheetSync,
  });
  notifyDocsChanged();
  return updated;
});

// ---- Blue Rock tracking sheet ----
handle('sheet:meta', () => trackingMeta());
handle('sheet:allocate', async (id) => {
  const doc = store.getDocument(id);
  if (!doc) throw new Error('Document not found');
  const { ticket } = await allocateTicket(doc);
  const updated = store.updateDocument(id, { extraction: { ...(doc.extraction || {}), service_ticket: ticket } });
  notifyDocsChanged();
  return updated;
});
handle('sheet:sync', async (id) => {
  const doc = store.getDocument(id);
  if (!doc?.qb) throw new Error('Document has not been pushed yet');
  const res = await recordPushInTracking(doc);
  const updated = store.updateDocument(id, { sheetSync: { ok: true, at: new Date().toISOString(), ...res } });
  notifyDocsChanged();
  return updated;
});
handle('qb:connect', () => startConnect());
handle('qb:connect-manual', (args) => finishConnectManual(args));
handle('qb:status', () => qbStatus());
handle('qb:vendors', () => fetchVendors());

handle('drive:connect', () => startDriveConnect());
handle('drive:status', () => driveStatus());

handle('app:open-path', (p) => shell.showItemInFolder(p));
handle('app:versions', () => ({ app: app.getVersion(), electron: process.versions.electron }));

app.whenReady().then(() => {
  createWindow();
  restartPolling();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
