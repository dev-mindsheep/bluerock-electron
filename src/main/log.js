// Append-only error log in userData/logs — shareable for troubleshooting
// (QuickBooks errors include the intuit_tid Intuit support asks for).
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024; // rotate once past ~2 MB, keep one old file

export function logFilePath() {
  return path.join(app.getPath('userData'), 'logs', 'app.log');
}

export function logError(context, err) {
  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* no file yet */ }
    const line = `${new Date().toISOString()} [${context}] ${err?.stack || err?.message || String(err)}\n`;
    fs.appendFileSync(file, line);
  } catch { /* logging must never break the app */ }
}
