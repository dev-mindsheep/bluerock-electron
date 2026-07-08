// Local PDF text extraction via pdf.js (no AI, no network).
// Works for KAR's system-generated PDFs, which carry a real text layer.
import fs from 'node:fs';

let pdfjs = null;
async function lib() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

/**
 * Per-page text. Accepts a file path or a Buffer.
 * @returns {Promise<string[]>}
 */
export async function extractPdfPages(input) {
  const { getDocument } = await lib();
  const data = new Uint8Array(Buffer.isBuffer(input) ? input : fs.readFileSync(input));
  const doc = await getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Rebuild lines by grouping items on similar Y, ordered top->bottom then left->right.
    const items = content.items
      .filter((it) => it.str && it.str.trim() !== '')
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
    items.sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
    let text = '';
    let lastY = null;
    for (const it of items) {
      if (lastY !== null && Math.abs(it.y - lastY) > 2) text += '\n';
      else if (lastY !== null) text += ' ';
      text += it.str;
      lastY = it.y;
    }
    pages.push(text);
  }
  await doc.destroy();
  return pages;
}

/**
 * @returns {Promise<{text: string, numPages: number}>}
 */
export async function extractPdfText(filePath) {
  const pages = await extractPdfPages(filePath);
  return { text: pages.join('\n\n').trim(), numPages: pages.length };
}

/** Heuristic: does this PDF have a usable text layer (vs a scanned image)? */
export function looksLikeTextPdf(text) {
  return (text || '').replace(/\s+/g, '').length >= 150;
}
