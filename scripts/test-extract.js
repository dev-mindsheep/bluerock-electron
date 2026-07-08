// Standalone extraction test (no Electron needed):
//   node scripts/test-extract.js path/to/sample.pdf   -> pdf.js text + local parser
//   node scripts/test-extract.js path/to/sample.txt   -> local parser only
import fs from 'node:fs';
import { extractPdfText, looksLikeTextPdf } from '../src/main/extract/pdfText.js';
import { parseKarText } from '../src/main/extract/parser.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/test-extract.js <file.pdf|file.txt>');
  process.exit(1);
}

let text;
if (file.toLowerCase().endsWith('.pdf')) {
  const res = await extractPdfText(file);
  text = res.text;
  console.error(`--- pdf.js: ${res.numPages} page(s), ${text.length} chars, text-layer=${looksLikeTextPdf(text)} ---`);
} else {
  text = fs.readFileSync(file, 'utf8');
}

const { data, confidence, missing } = parseKarText(text);
console.log(JSON.stringify({ confidence, missing, data }, null, 2));
