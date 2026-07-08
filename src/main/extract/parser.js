// Rule-based parser for KAR e-service Purchase/Service Request text
// (as produced by pdfText.js from the system-generated PDFs).
// Returns { data, confidence, missing } — the pipeline falls back to AI
// extraction when confidence is low.

const SAGE_PREFIXES = ['OFSU', 'CIVL', 'TOEQ', 'ITDE', 'TOOL', 'FURN', 'IT'];
const UOMS = ['Piece', 'Box', 'Set', 'Carton', 'Bag', 'Roll', 'Packet', 'Meter', 'KG', 'M3', 'Pcs', 'Liter', 'Litre', 'Drum', 'Pair', 'Unit', 'Sets'];

const SAGE_RE = new RegExp(`\\b(${SAGE_PREFIXES.join('|')})\\s*-\\s*(\\d{4,5})\\b`, 'g');
const UOM_RE = UOMS.join('|');

function firstMatch(text, regexes) {
  for (const re of regexes) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

export function parseKarText(text) {
  let t = text.replace(/[ \t]+/g, ' ');
  // Rejoin sage codes that the PDF layout splits across lines
  // ("... 3 Piece ITDE- <purpose text>\n00703 <more purpose> ..."):
  t = t.replace(
    new RegExp(`\\b(${SAGE_PREFIXES.join('|')})-\\s*([^\\n]*)\\n(\\d{4,5})\\b`, 'g'),
    (_, prefix, rest, digits) => `${prefix}-${digits} ${rest}`
  );

  const numMatch = t.match(/(Purchase|Service)\s*Request\s*#?\s*(\d{4,6})/i);
  const docType = numMatch
    ? (numMatch[1].toLowerCase() === 'service' ? 'service_request' : 'purchase_request')
    : (/Service Description/i.test(t) ? 'service_request' : 'purchase_request');
  const number = numMatch ? numMatch[2] : null;

  const date = firstMatch(t, [/Date:?\s*(\d{2}\/\d{2}\/\d{4})/]);
  const requesterName = firstMatch(t, [
    /Name:?\s*([A-Za-z][A-Za-z' .-]{2,60}?)\s*(?=Date|Phone|Department|Project|\n)/,
  ]);
  const phone = firstMatch(t, [/Phone\s*No\.?:?\s*(\+?[\d][\d ()-]{6,18})/]);
  const department = firstMatch(t, [
    /Department:?\s*([A-Za-z][A-Za-z .&/]{1,40}?)\s*(?=Phone|Note|Priori?ty|Project|Purchase|Date|No\.|\n)/,
  ]);
  const project = firstMatch(t, [
    /Project:?\s*((?:Purchase|Service)\s*Request\s*[-–]?\s*(?:Loading\s*)?KAR\s*\d)/i,
    /Project:?\s*([^\n]{3,60}?)(?=\s*(?:Department|Purchase Type|No\. of|Priori?ty|\n))/,
  ]);
  const priority = firstMatch(t, [/Priori?ty:?\s*(Emergency|Urgent|Normal|High|Low)/i]);
  const purchaseType = firstMatch(t, [/Purchase\s*Type:?\s*(Local\s*PR|Foreign\s*PR|[A-Za-z ]{2,20}?)(?=\s*(?:Department|Date|Project|Note|\n))/i]);
  const note = firstMatch(t, [/Note:?\s*([^\n]{4,300}?)(?=\s*(?:Priori?ty|Project|Purchase Type|No\. of|\n))/]);

  // Project site normalisation (KAR 1 / KAR 2 / KAR 3)
  const siteMatch = (project || t).match(/KAR\s*[- ]?\s*([123])/i);
  const projectSite = siteMatch ? `KAR ${siteMatch[1]}` : null;

  // Line items: anchor on "<qty> <uom> <sage-code>" runs.
  const lineItems = [];
  const itemRe = new RegExp(
    `(\\d{1,7})\\s+(${UOM_RE})\\s+((?:${SAGE_PREFIXES.join('|')})\\s*-\\s*\\d{4,5})`,
    'gi'
  );
  let m;
  let prevEnd = 0;
  const anchors = [];
  while ((m = itemRe.exec(t)) !== null) anchors.push({ m, index: m.index, end: itemRe.lastIndex });
  for (let i = 0; i < anchors.length; i++) {
    const { m: am, index, end } = anchors[i];
    // Description: text between previous anchor (or a nearby line start) and this qty.
    const from = i === 0 ? Math.max(0, index - 200) : anchors[i - 1].end;
    let desc = t.slice(from, index).split('\n').pop().trim();
    desc = desc.replace(/^\d{1,2}\s+/, '').trim(); // strip row number
    // Purpose: text after code up to next anchor / approver / end-of-line.
    const to = i + 1 < anchors.length ? anchors[i + 1].index : Math.min(t.length, end + 200);
    let purpose = t.slice(end, to).split('\n')[0].trim();
    purpose = purpose.replace(/^[.,:;-]\s*/, '').slice(0, 200);
    lineItems.push({
      no: i + 1,
      description: desc.slice(0, 300) || null,
      qty: Number(am[1]),
      uom: am[2],
      sage_code: am[3].replace(/\s*/g, '').toUpperCase(),
      purpose: purpose || null,
    });
    prevEnd = end;
  }

  // Service Requests have no Sage column — rows look like:
  //   "1 Repairing tablet ... 1 Piece for q-system staff"
  if (!lineItems.length && docType === 'service_request') {
    const srRow = new RegExp(`^(\\d{1,2})\\s+(.{5,240}?)\\s+(\\d{1,5})\\s+(${UOM_RE})\\s+(.{0,200})$`, 'gim');
    while ((m = srRow.exec(t)) !== null) {
      lineItems.push({
        no: Number(m[1]),
        description: m[2].trim(),
        qty: Number(m[3]),
        uom: m[4],
        sage_code: null,
        purpose: m[5].trim() || null,
      });
    }
  }

  // Approval chain
  const approvals = [];
  const apprRe = /([A-Z][A-Za-z'.-]+(?: [A-Z][A-Za-z'.-]+){1,4})\s+Approved\s+(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})/g;
  while ((m = apprRe.exec(t)) !== null) {
    approvals.push({ name: m[1].trim(), status: 'Approved', timestamp: m[2] });
  }

  const data = {
    doc_type: docType,
    number,
    date,
    requester_name: requesterName,
    requester_phone: phone,
    department,
    project: project || null,
    project_site: projectSite,
    priority: priority || null,
    purchase_type: purchaseType || null,
    note: note || null,
    line_items: lineItems,
    approvals,
  };

  // Confidence: weight the fields that matter for a QB entry.
  const checks = [
    [!!number, 3],
    [lineItems.length > 0, 3],
    // SRs have no Sage column, so only require codes on purchase requests
    [lineItems.length > 0 && lineItems.every((li) => (docType === 'service_request' || li.sage_code) && li.qty > 0), 2],
    [!!date, 1],
    [!!department, 1],
    [!!requesterName, 1],
    [approvals.length > 0, 1],
  ];
  const total = checks.reduce((s, [, w]) => s + w, 0);
  const got = checks.reduce((s, [ok, w]) => s + (ok ? w : 0), 0);
  const missing = [];
  if (!number) missing.push('number');
  if (!lineItems.length) missing.push('line_items');
  if (!date) missing.push('date');
  if (!department) missing.push('department');
  if (!requesterName) missing.push('requester_name');
  // Multi-line notes get truncated by column interleaving — flag for human review
  // when the captured note looks cut off mid-sentence.
  if (note && note.length > 50 && !/[.!؟?]$/.test(note.trim())) missing.push('note');
  if (!approvals.length) missing.push('approvals');

  return { data, confidence: got / total, missing };
}
