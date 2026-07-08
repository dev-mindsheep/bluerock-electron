// Extraction pipeline orchestrator.
//   typed PDF  -> local pdf.js text extraction -> rule-based parser
//                 (AI fallback when parser confidence is low, or forced via settings)
//   image/scan -> AI vision extraction (Claude or GPT)
import { extractPdfText, looksLikeTextPdf } from './pdfText.js';
import { parseKarText } from './parser.js';
import { aiExtract } from './ai.js';

const PARSER_CONFIDENCE_THRESHOLD = 0.85;

/**
 * @param {object} doc       store document
 * @param {object} settings  full settings object
 * @returns extraction object saved onto the document
 */
export async function runExtraction(doc, settings) {
  const ai = settings.ai;

  if (doc.mime === 'application/pdf') {
    const { text } = await extractPdfText(doc.filePath);
    if (looksLikeTextPdf(text) && ai.useAiForTypedPdfs !== 'always') {
      const parsed = parseKarText(text);
      if (parsed.confidence >= PARSER_CONFIDENCE_THRESHOLD || ai.useAiForTypedPdfs === 'never') {
        return {
          ...parsed.data,
          low_confidence_fields: parsed.missing,
          _method: 'local-parser',
          _confidence: Number(parsed.confidence.toFixed(2)),
          _extractedAt: new Date().toISOString(),
          _rawTextLength: text.length,
        };
      }
      // Low parser confidence: hand the extracted text to the AI (text-only, cheap).
      const aiRes = await aiExtract({ ai, text });
      return finishAi(aiRes, 'ai-text');
    }
    if (looksLikeTextPdf(text)) {
      const aiRes = await aiExtract({ ai, text });
      return finishAi(aiRes, 'ai-text');
    }
    // Scanned PDF with no text layer — no direct image path for a PDF page yet;
    // clearest failure mode for the POC is to say so.
    throw new Error(
      'This PDF has no text layer (scanned image). Export it as an image (JPG/PNG) and drop it in, or re-export the PDF from the KAR system.'
    );
  }

  // Image input -> AI vision
  const aiRes = await aiExtract({ ai, imagePath: doc.filePath, mime: doc.mime });
  return finishAi(aiRes, 'ai-vision');
}

function finishAi(aiRes, method) {
  return {
    ...aiRes.data,
    _method: `${method}:${aiRes.provider}:${aiRes.model}`,
    _confidence: null,
    _extractedAt: new Date().toISOString(),
  };
}
