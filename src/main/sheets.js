// Blue Rock's master tracking sheet ("BR Operation 26" — one row per Service
// Ticket). The app reserves the next ST number by appending a row the moment
// the reviewer clicks "Next ST" (so two people can never take the same number,
// and the sheet always shows it as taken), and completes the row — status,
// QB invoice number, bill register — when the order is pushed.
//
// Talks to Alan's existing sheet directly through the Drive connection's OAuth
// tokens: the Workspace consent screen is Internal, so the spreadsheets scope
// needs no Google verification. Requirements: the Google Sheets API enabled in
// the same GCP project as the Drive client, and a one-time Drive reconnect
// after this feature ships (older tokens lack the spreadsheet permission).
import { getSettings } from './settings.js';
import { driveAccessToken } from './drive.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const enc = (s) => encodeURIComponent(s);

// The sheet's column headers, matched case-insensitively wherever they sit on
// the header row — the integration survives Blue Rock reordering columns or
// adding new ones (unknown columns are simply left alone).
const HEADERS = {
  ticket: 'service ticket',
  category: 'category',
  location: 'kar location',
  status: 'status',
  order: 'client order #',
  date: 'receiving date',
  invoice: 'qb invoice number',
  bill: 'bill register',
};

function sheetId() {
  const url = (getSettings().drive.trackingSheetUrl || '').trim();
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) || url.match(/^([a-zA-Z0-9_-]{25,})$/);
  if (!m) throw new Error('Tracking sheet URL not set or not a Google Sheets link (Settings > Google Drive)');
  return m[1];
}

function assertSheetsScope() {
  const t = getSettings().drive.tokens;
  if (!t?.refresh_token) throw new Error('Not connected to Google Drive (Settings > Google Drive)');
  if (!(t.scope || '').includes('/spreadsheets')) {
    throw new Error('The Google connection predates the tracking-sheet feature — click "Connect to Google Drive…" in Settings once to grant the spreadsheet permission');
  }
}

async function sheetsFetch(url, opts = {}) {
  assertSheetsScope();
  const token = await driveAccessToken();
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 403 && /has not been used|is disabled/i.test(text)) {
      throw new Error('The Google Sheets API is not enabled for the Drive project — enable it under APIs & Services at console.cloud.google.com, then retry');
    }
    if (res.status === 403) {
      throw new Error('Google refused spreadsheet access — check the sheet is owned by (or shared, with edit rights, with) the connected Google account, and reconnect Google Drive in Settings if the connection is old');
    }
    if (res.status === 404) {
      throw new Error('Tracking sheet not found — check the sheet URL in Settings > Google Drive');
    }
    if (/must not be an Office file/i.test(text)) {
      throw new Error('The tracking sheet is an Excel (.xlsx) file — the Sheets API only works with native Google Sheets. Open it in Drive, use File > Save as Google Sheets, then paste the NEW sheet’s URL into Settings > Google Drive');
    }
    throw new Error(`Sheets API ${res.status}: ${text}`);
  }
  return res.json();
}

/** Read the tab and locate the header row + column positions. */
async function readTracking() {
  const d = getSettings().drive;
  const id = sheetId();
  const tab = (d.trackingSheetTab || '').trim() || 'Operation';
  const body = await sheetsFetch(`${API}/${id}/values/${enc(`'${tab.replace(/'/g, "''")}'!A1:Z`)}`);
  const rows = body.values || [];
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const lower = (rows[r] || []).map((c) => String(c ?? '').trim().toLowerCase());
    if (!lower.includes(HEADERS.ticket)) continue;
    const cols = {};
    for (const [key, label] of Object.entries(HEADERS)) {
      const i = lower.indexOf(label);
      if (i !== -1) cols[key] = i;
    }
    return { id, tab, headerRow: r, cols, rows };
  }
  throw new Error(`No "Service ticket" header found in tab "${tab}" of the tracking sheet — check the tab name in Settings > Google Drive`);
}

const ticketVals = (t) =>
  t.rows.slice(t.headerRow + 1).map((r) => String((r || [])[t.cols.ticket] ?? '').trim());

function nextTicket(t) {
  let max = 0;
  for (const v of ticketVals(t)) {
    const m = /^ST0*(\d+)$/i.exec(v);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'ST' + String(max + 1).padStart(5, '0');
}

const colLetter = (i) => String.fromCharCode(65 + i); // header spans A–Z at most (read range is A1:Z)

/**
 * The cells the app owns on a ticket's row, keyed by column index. Blank
 * values are omitted so a human-entered cell is never wiped by an empty field.
 */
function rowCells(t, doc, extra = {}) {
  const ex = doc.extraction || {};
  const out = {};
  const put = (key, value) => {
    if (t.cols[key] != null && value != null && String(value).trim() !== '') out[t.cols[key]] = String(value).trim();
  };
  put('ticket', extra.ticket);
  put('category', ex.tracking_category);
  put('location', ex.project_site);
  put('status', ex.tracking_status);
  put('order', ex.number);
  put('date', ex.date);
  put('invoice', extra.invoice);
  put('bill', extra.bill);
  return out;
}

function cellsToRow(t, cells) {
  const width = Math.max(...Object.values(t.cols)) + 1;
  return Array.from({ length: width }, (_, i) => cells[i] ?? '');
}

async function appendRow(t, cells) {
  const appended = await sheetsFetch(
    `${API}/${t.id}/values/${enc(`'${t.tab.replace(/'/g, "''")}'!A${t.headerRow + 1}`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: { values: [cellsToRow(t, cells)] } }
  );
  // "'Operation'!A1700:H1700" → 1700
  return Number((appended.updates?.updatedRange || '').match(/![A-Z]+(\d+)/)?.[1] || 0) || null;
}

/**
 * Reserve the next Service Ticket number: compute max+1 from the ticket
 * column, append the reservation row, then re-read to catch the rare race
 * where someone else (a second reviewer, or a human typing directly into the
 * sheet) took the same number in the same moment — the later row moves to a
 * fresh number.
 */
export async function allocateTicket(doc) {
  const t = await readTracking();
  const ticket = nextTicket(t);
  const myRow = await appendRow(t, rowCells(t, doc, { ticket }));

  const t2 = await readTracking();
  const firstRow = ticketVals(t2).findIndex((v) => v.toUpperCase() === ticket.toUpperCase());
  const firstSheetRow = firstRow === -1 ? null : firstRow + t2.headerRow + 2; // 1-based sheet row
  if (myRow && firstSheetRow && firstSheetRow !== myRow) {
    const fresh = nextTicket(t2);
    await sheetsFetch(
      `${API}/${t.id}/values/${enc(`'${t.tab.replace(/'/g, "''")}'!${colLetter(t.cols.ticket)}${myRow}`)}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', body: { values: [[fresh]] } }
    );
    return { ticket: fresh, row: myRow };
  }
  return { ticket, row: myRow };
}

/**
 * Complete (or create) the ticket's row after a successful push: category,
 * location, order number, date, status, QB invoice number and bill register.
 * The row is found by its ticket value at write time — row positions are
 * never trusted across reads, since humans also edit this sheet.
 */
export async function recordPushInTracking(doc) {
  const ticket = (doc.extraction?.service_ticket || '').trim();
  if (!ticket) return { skipped: 'no Service ticket on the document' };
  const t = await readTracking();
  const invoice = doc.qb?.invoiceDocNumber || doc.qb?.invoiceId || null;
  const cells = rowCells(t, doc, {
    ticket,
    invoice,
    bill: (doc.extraction.bill_register ?? 'R') || null,
  });

  const idx = ticketVals(t).findIndex((v) => v.toUpperCase() === ticket.toUpperCase());
  if (idx === -1) {
    // Ticket was typed by hand and isn't in the sheet yet — add its row now.
    const row = await appendRow(t, cells);
    return { row, added: true };
  }

  const rowNum = idx + t.headerRow + 2;
  const data = Object.entries(cells).map(([col, v]) => ({
    range: `'${t.tab.replace(/'/g, "''")}'!${colLetter(Number(col))}${rowNum}`,
    values: [[v]],
  }));
  await sheetsFetch(`${API}/${t.id}/values:batchUpdate`, {
    method: 'POST',
    body: { valueInputOption: 'USER_ENTERED', data },
  });
  return { row: rowNum, added: false };
}

/**
 * Sheet facts for the review screen: existing Category/Status values (for the
 * suggestion dropdowns — most-used first) and the next free ticket number.
 */
export async function trackingMeta() {
  const t = await readTracking();
  const uniq = (key, cap = 30) => {
    if (t.cols[key] == null) return [];
    const counts = new Map();
    for (const r of t.rows.slice(t.headerRow + 1)) {
      const v = String((r || [])[t.cols[key]] ?? '').trim();
      if (v) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([v]) => v);
  };
  return {
    categories: uniq('category'),
    statuses: uniq('status'),
    nextTicket: nextTicket(t),
    rows: Math.max(0, t.rows.length - t.headerRow - 1),
  };
}
