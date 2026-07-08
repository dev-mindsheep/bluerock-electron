// Local PDF text extraction via pdf.js (no AI, no network).
// Works for KAR's system-generated PDFs, which carry a real text layer.
import fs from 'node:fs';

let pdfjs = null;
async function lib() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

/**
 * @returns {Promise<{text: string, numPages: number}>}
 */
export async function extractPdfText(filePath) {
  const { getDocument } = await lib();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Rebuild lines by grouping items on similar Y, ordered top->bottom then left->right.
    const items = content.items
      .filter((it) => it.str && it.str.trim() !== '')
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
    items.sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
    let lastY = null;
    for (const it of items) {
      if (lastY !== null && Math.abs(it.y - lastY) > 2) text += '\n';
      else if (lastY !== null) text += ' ';
      text += it.str;
      lastY = it.y;
    }
    text += '\n\n';
  }
  await doc.destroy();
  return { text: text.trim(), numPages: doc.numPages };
}

/** Heuristic: does this PDF have a usable text layer (vs a scanned image)? */
export function looksLikeTextPdf(text) {
  return (text || '').replace(/\s+/g, '').length >= 150;
}
