// Local document store: metadata in documents.json, originals copied under userData/files/<id>/.
// Everything stays on this machine — no cloud storage is required for the app to work.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

let cache = null;

function dbFile() { return path.join(app.getPath('userData'), 'documents.json'); }
function filesDir() { return path.join(app.getPath('userData'), 'files'); }

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(dbFile(), 'utf8'));
  } catch {
    cache = [];
  }
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
  fs.writeFileSync(dbFile(), JSON.stringify(cache, null, 2));
}

export function listDocuments() {
  // newest first
  return [...load()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function getDocument(id) {
  return load().find((d) => d.id === id) || null;
}

export function mimeFor(fileName) {
  return MIME_BY_EXT[path.extname(fileName || '').toLowerCase()] || null;
}

/**
 * Add a document from a file path or a Buffer.
 * @param {{sourcePath?: string, buffer?: Buffer, fileName: string, source: 'email'|'drop', meta?: object}} opts
 */
export function addDocument({ sourcePath, buffer, fileName, source, meta = {} }) {
  const mime = mimeFor(fileName);
  if (!mime) throw new Error(`Unsupported file type: ${fileName} (PDF, JPG, PNG, WEBP only)`);
  const id = crypto.randomUUID();
  const dir = path.join(filesDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(fileName));
  if (buffer) fs.writeFileSync(dest, buffer);
  else fs.copyFileSync(sourcePath, dest);
  const doc = {
    id,
    createdAt: new Date().toISOString(),
    source,
    meta, // e.g. { from, subject, receivedAt } for email
    fileName: path.basename(fileName),
    filePath: dest,
    mime,
    status: 'new', // new -> extracted -> pushed | flagged | skipped | error
    extraction: null,
    error: null,
    qb: null, // { pushedAt, billId, docNumber, mock }
    driveFile: null,
  };
  load().push(doc);
  persist();
  return doc;
}

export function updateDocument(id, patch) {
  const doc = getDocument(id);
  if (!doc) throw new Error('Document not found');
  Object.assign(doc, patch);
  persist();
  return doc;
}

export function deleteDocument(id) {
  const docs = load();
  const i = docs.findIndex((d) => d.id === id);
  if (i === -1) return false;
  const [doc] = docs.splice(i, 1);
  persist();
  try { fs.rmSync(path.dirname(doc.filePath), { recursive: true, force: true }); } catch { /* ignore */ }
  return true;
}
