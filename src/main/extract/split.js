// Bundle detection: a single PDF sometimes contains several PRs/SRs
// (staff scan a stack of pages into one file). We detect distinct document
// headers per page and split the PDF so each document gets its own queue
// entry — while a genuine multi-page document (same PR number on page 2)
// stays as one file.
import { PDFDocument } from 'pdf-lib';
import { extractPdfPages } from './pdfText.js';

const HEAD_RE = /(Purchase|Service)\s*Request\s*#\s*(\d{4,6})/i;

/**
 * @param {Buffer} buffer PDF bytes
 * @returns {Promise<null | Array<{buffer: Buffer, number: string|null, pageCount: number}>>}
 *   null when the PDF is a single document (or has no text layer to judge by).
 */
export async function splitPdfBundle(buffer) {
  let pageTexts;
  try {
    pageTexts = await extractPdfPages(buffer);
  } catch {
    return null; // unreadable — let the normal pipeline surface the error
  }
  if (pageTexts.length < 2) return null;

  const groups = [];
  let current = null;
  pageTexts.forEach((txt, i) => {
    const m = (txt || '').match(HEAD_RE);
    const num = m ? m[2] : null;
    if (!current) {
      current = { number: num, pages: [i] };
      groups.push(current);
    } else if (num && current.number && num !== current.number) {
      // new document header with a different number -> new group
      current = { number: num, pages: [i] };
      groups.push(current);
    } else {
      // continuation page (no header, or same number repeated)
      current.pages.push(i);
      if (!current.number && num) current.number = num;
    }
  });

  if (groups.length <= 1) {
    // No headers found anywhere + no text layer => a scanned bundle.
    // KAR PRs/SRs are single-page documents, so default to one page per
    // document; a continuation page shows up in review with no PR number
    // and can be skipped/merged by the operator.
    const totalText = pageTexts.join('').replace(/\s+/g, '').length;
    const anyHeader = groups[0]?.number != null;
    if (!anyHeader && totalText < 150 && pageTexts.length >= 2) {
      groups.length = 0;
      pageTexts.forEach((_, i) => groups.push({ number: null, pages: [i] }));
    } else {
      return null;
    }
  }

  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const parts = [];
  for (const g of groups) {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, g.pages);
    for (const p of copied) out.addPage(p);
    parts.push({
      buffer: Buffer.from(await out.save()),
      number: g.number,
      pageCount: g.pages.length,
    });
  }
  return parts;
}
