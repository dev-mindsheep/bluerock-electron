// Single entry point for adding documents to the queue (drag-drop, file picker,
// email). Multi-document PDF bundles are split so each PR/SR gets its own entry.
import fs from 'node:fs';
import path from 'node:path';
import { addDocument, mimeFor } from './store.js';
import { splitPdfBundle } from './extract/split.js';

/**
 * @param {{sourcePath?: string, buffer?: Buffer, fileName: string, source: 'email'|'drop', meta?: object}} opts
 * @returns {Promise<object[]>} the created document records (1..n)
 */
export async function ingestFile({ sourcePath, buffer, fileName, source, meta = {} }) {
  const mime = mimeFor(fileName);
  if (mime === 'application/pdf') {
    const buf = buffer || fs.readFileSync(sourcePath);
    const parts = await splitPdfBundle(buf);
    if (parts) {
      const base = path.basename(fileName).replace(/\.pdf$/i, '');
      return parts.map((p, i) =>
        addDocument({
          buffer: p.buffer,
          fileName: `${base} - ${p.number ? `#${p.number}` : `part ${i + 1}`}.pdf`,
          source,
          meta: { ...meta, bundle: path.basename(fileName), bundlePart: i + 1, bundleParts: parts.length },
        })
      );
    }
  }
  return [addDocument({ sourcePath, buffer, fileName, source, meta })];
}
