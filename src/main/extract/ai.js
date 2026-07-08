// AI extraction: Claude (default) or OpenAI, selected in the admin tab.
// Both paths force structured JSON output against the same schema, so the
// review UI receives an identical shape regardless of provider.
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'doc_type', 'number', 'date', 'requester_name', 'requester_phone',
    'department', 'project', 'project_site', 'priority', 'purchase_type',
    'note', 'line_items', 'approvals', 'low_confidence_fields',
  ],
  properties: {
    doc_type: { type: 'string', enum: ['purchase_request', 'service_request'] },
    number: { type: 'string', description: 'PR/SR number, digits only; "" if unreadable' },
    date: { type: 'string', description: 'Document date as DD/MM/YYYY; "" if unreadable' },
    requester_name: { type: 'string' },
    requester_phone: { type: 'string' },
    department: { type: 'string' },
    project: { type: 'string', description: 'Full project line, e.g. "Purchase Request - KAR 2"' },
    project_site: { type: 'string', description: 'Exactly "KAR 1", "KAR 2" or "KAR 3"; "" if not determinable' },
    priority: { type: 'string' },
    purchase_type: { type: 'string' },
    note: { type: 'string' },
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['no', 'description', 'qty', 'uom', 'sage_code', 'purpose'],
        properties: {
          no: { type: 'integer', description: 'Row number (1-based)' },
          description: { type: 'string' },
          qty: { type: ['number', 'null'], description: 'null if unreadable' },
          uom: { type: 'string' },
          sage_code: { type: 'string', description: 'e.g. OFSU-00126; "" if absent (Service Requests have no Sage column)' },
          purpose: { type: 'string' },
        },
      },
    },
    approvals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status', 'timestamp'],
        properties: {
          name: { type: 'string' },
          status: { type: 'string' },
          timestamp: { type: 'string', description: 'DD/MM/YYYY HH:MM:SS; "" if unreadable' },
        },
      },
    },
    low_confidence_fields: {
      type: 'array',
      items: { type: 'string' },
      description: 'Field names you are unsure about (blurry, cut off, ambiguous)',
    },
  },
};

const PROMPT = `You are extracting structured data from a KAR Oil Refinery procurement document
(a Purchase Request or Service Request from the internal e-service system at app.karbusiness.com).
The input may be clean text, a phone photo of a printed page, or a photo of a computer screen
(expect glare, skew, moire). Extract every field faithfully; use an empty string "" when a text value is absent or
unreadable (null for unreadable quantities), and list any field you are unsure about in low_confidence_fields.
Sage codes have the form PREFIX-NNNNN with prefixes OFSU, CIVL, TOEQ, ITDE, TOOL, IT, FURN.
Notes may contain Kurdish/Arabic text — transcribe as-is.
Line items appear in a table: row number, material/service description, QTY, UoM, Sage Code, Purpose Of Use.
The approval chain lists approver names with "Approved" and a DD/MM/YYYY HH:MM:SS timestamp.`;

function fileToBase64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

// The schema uses "" for absent values (Anthropic caps union-typed fields at 16);
// normalize back to null so the rest of the app sees one convention.
function emptyToNull(v) {
  if (v === '') return null;
  if (Array.isArray(v)) return v.map(emptyToNull);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, emptyToNull(x)]));
  }
  return v;
}

/**
 * @param {object} opts
 * @param {object} opts.ai        settings.ai section
 * @param {string} [opts.text]    extracted PDF text (text mode)
 * @param {string} [opts.imagePath] image file (vision mode)
 * @param {string} [opts.pdfPath]  scanned PDF with no text layer (Claude reads pages as images)
 * @param {string} [opts.mime]
 */
export async function aiExtract({ ai, text, imagePath, pdfPath, mime }) {
  if (ai.provider === 'openai') {
    if (pdfPath) {
      throw new Error(
        'Scanned PDFs (no text layer) require the Anthropic provider, which reads PDF pages as images. Switch provider in Settings > AI, or convert the scan to JPG/PNG.'
      );
    }
    return openaiExtract({ ai, text, imagePath, mime });
  }
  return anthropicExtract({ ai, text, imagePath, pdfPath, mime });
}

async function anthropicExtract({ ai, text, imagePath, pdfPath, mime }) {
  const key = (ai.anthropicKey || '').trim();
  if (!key) throw new Error('Anthropic API key not configured (Settings > AI)');
  const client = new Anthropic({ apiKey: key });

  const content = [];
  if (pdfPath) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: fileToBase64(pdfPath) },
    });
    content.push({ type: 'text', text: 'Extract the procurement document data from this scanned PDF.' });
  } else if (imagePath) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mime, data: fileToBase64(imagePath) },
    });
    content.push({ type: 'text', text: 'Extract the procurement document data from this image.' });
  } else {
    content.push({ type: 'text', text: `Extract the procurement document data from this text:\n\n${text}` });
  }

  const response = await client.messages.create({
    model: ai.anthropicModel || 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: PROMPT,
    output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to process this document (safety refusal)');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Extraction output was truncated — try again or reduce document size');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No extraction output returned');
  return { data: emptyToNull(JSON.parse(textBlock.text)), provider: 'anthropic', model: response.model };
}

async function openaiExtract({ ai, text, imagePath, mime }) {
  const key = (ai.openaiKey || '').trim();
  if (!key) throw new Error('OpenAI API key not configured (Settings > AI)');

  const userContent = [];
  if (imagePath) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${fileToBase64(imagePath)}` },
    });
    userContent.push({ type: 'text', text: 'Extract the procurement document data from this image.' });
  } else {
    userContent.push({ type: 'text', text: `Extract the procurement document data from this text:\n\n${text}` });
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: ai.openaiModel || 'gpt-4o',
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: userContent },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'kar_procurement_doc', strict: true, schema: EXTRACTION_SCHEMA },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const msg = json.choices?.[0]?.message;
  if (msg?.refusal) throw new Error(`OpenAI refused: ${msg.refusal}`);
  return { data: emptyToNull(JSON.parse(msg.content)), provider: 'openai', model: json.model };
}
