/* Blue Rock Procurement — renderer (vanilla JS, no build step) */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  view: 'queue',       // 'queue' | 'review' | 'settings'
  docs: [],
  settings: null,
  selectedId: null,
  fileUrl: null,
  busy: false,
};

const STATUS_LABEL = {
  new: 'New', extracting: 'Extracting…', extracted: 'Ready for review',
  pushed: 'Pushed to QB', error: 'Error', flagged: 'Flagged', skipped: 'Skipped',
};

// ---------- status bar ----------
function pushStatus(message, level = 'info') {
  const bar = $('#statusbar');
  const line = document.createElement('div');
  line.className = level === 'error' ? 'err' : '';
  line.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
  bar.prepend(line);
  while (bar.children.length > 12) bar.lastChild.remove();
}
window.api.onStatus(({ message, level }) => pushStatus(message, level));

// Swap a button's label for a spinner while an async action runs, so slow
// operations (extraction, OAuth, pushes) never look stuck. Safe even when the
// handler re-renders the view — the restored button is simply discarded.
async function withSpinner(btn, label, fn) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${label}`;
  try { return await fn(); }
  finally { btn.disabled = false; btn.innerHTML = orig; }
}

// ---------- data ----------
async function refreshDocs() {
  state.docs = await window.api.docs.list();
  if (state.view === 'queue') renderQueue();
}
window.api.onDocsChanged(() => refreshDocs());

// ---------- navigation ----------
$$('.nav-btn').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.nav-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.view = b.dataset.view;
    render();
  })
);

function render() {
  if (state.view === 'queue') renderQueue();
  else if (state.view === 'review') renderReview();
  else renderSettings();
}

// ============================================================ QUEUE
function renderQueue() {
  const main = $('#main');
  main.innerHTML = `
    <div class="toolbar">
      <h1>Document Queue</h1>
      <button class="btn" id="btn-add">Add files…</button>
      <button class="btn" id="btn-check-email">Check email now</button>
    </div>
    <div class="scroll">
      <div id="dropzone">Drag &amp; drop PDF or image files here (or click to browse)</div>
      <div id="doc-list"></div>
    </div>`;

  $('#btn-add').onclick = pickFiles;
  $('#btn-check-email').onclick = (e) => withSpinner(e.currentTarget, 'Checking…', async () => {
    try {
      const { added, checked } = await window.api.email.checkNow();
      pushStatus(`Email checked: ${checked} unseen message(s), ${added} document(s) added`);
    } catch (err) { pushStatus(err.message, 'error'); }
  });

  const dz = $('#dropzone');
  dz.onclick = pickFiles;
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag'); };
  dz.ondragleave = () => dz.classList.remove('drag');
  dz.ondrop = async (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const { added, errors } = await window.api.docs.addFiles(paths);
    pushStatus(`${added} file(s) added${errors.length ? `; skipped: ${errors.join('; ')}` : ''}`, errors.length ? 'error' : 'info');
  };

  const list = $('#doc-list');
  if (!state.docs.length) {
    list.innerHTML = '<div class="empty">No documents yet. Drop files above or configure email intake in Settings.</div>';
    return;
  }
  list.innerHTML = state.docs.map((d) => {
    const icon = d.mime === 'application/pdf' ? '📄' : '🖼️';
    const src = d.source === 'email' ? `✉️ ${esc(d.meta?.from || 'email')} — ${esc(d.meta?.subject || '')}` : 'Dropped file';
    const num = d.extraction?.number ? ` · ${d.extraction.doc_type === 'service_request' ? 'SR' : 'PR'} #${esc(d.extraction.number)}` : '';
    return `
      <div class="doc-row" data-id="${d.id}">
        <div class="doc-icon">${icon}</div>
        <div class="doc-main">
          <div class="doc-title">${esc(d.fileName)}${num}</div>
          <div class="doc-sub">${src} · ${new Date(d.createdAt).toLocaleString()}${d.error ? ` · <span style="color:var(--red)">${esc(d.error)}</span>` : ''}</div>
        </div>
        <span class="pill ${d.status}">${STATUS_LABEL[d.status] || d.status}</span>
      </div>`;
  }).join('');
  $$('.doc-row', list).forEach((row) =>
    row.addEventListener('click', () => openReview(row.dataset.id))
  );
}

async function pickFiles() {
  const { added, errors } = await window.api.docs.pickFiles();
  if (added) pushStatus(`${added} file(s) added`);
  errors.forEach((e) => pushStatus(e, 'error'));
}

// ============================================================ REVIEW
async function openReview(id) {
  state.selectedId = id;
  state.view = 'review';
  state.fileUrl = await window.api.docs.fileUrl(id);
  let doc = await window.api.docs.get(id);
  renderReview(doc);
  if (doc.status === 'new' || (!doc.extraction && doc.status !== 'extracting')) {
    await extractNow(id);
  }
}

async function extractNow(id) {
  state.extractingId = id;
  try {
    pushStatus('Extracting…');
    if (state.view === 'review' && state.selectedId === id) await renderReview();
    await window.api.extract.run(id);
    pushStatus('Extraction complete');
  } catch (err) {
    pushStatus(`Extraction failed: ${err.message}`, 'error');
  }
  state.extractingId = null;
  const doc = await window.api.docs.get(id);
  if (state.view === 'review' && state.selectedId === id) renderReview(doc);
}

function fieldHtml(label, key, value, { warn = false, type = 'text' } = {}) {
  return `
    <div class="field ${warn ? 'warn' : ''}">
      <label>${label}${warn ? ' ⚠︎' : ''}</label>
      <input type="${type}" data-key="${key}" value="${esc(value ?? '')}" />
    </div>`;
}

async function renderReview(docArg) {
  const doc = docArg || (await window.api.docs.get(state.selectedId));
  if (!doc) { state.view = 'queue'; return render(); }
  const extracting = doc.status === 'extracting' || state.extractingId === doc.id;
  const ex = doc.extraction || {};
  const low = new Set(ex.low_confidence_fields || []);
  const main = $('#main');

  const viewer = doc.mime === 'application/pdf'
    ? `<iframe src="${state.fileUrl}"></iframe>`
    : `<img src="${state.fileUrl}" alt="document" />`;

  const items = ex.line_items || [];
  // The 15 prefixes from Blue Rock's System Code sheet + ITDE and TOEQ, which
  // appear on real KAR PRs (#28961/#33582 and #33114) but not on the sheet.
  const sageOk = (c) => /^(CHEM|CIVL|ELEC|FIRE|FURN|INST|IT|ITDE|LABO|MECH|MEDI|OFSU|SAFE|SRVC|STAT|TOEQ|TOOL)-\d{4,5}$/.test(c || '');

  main.innerHTML = `
    <div class="toolbar">
      <button class="btn" id="btn-back">← Queue</button>
      <h1>${esc(doc.fileName)}</h1>
      <span class="pill ${doc.status}">${STATUS_LABEL[doc.status] || doc.status}</span>
      <button class="btn" id="btn-reextract" ${state.busy || extracting ? 'disabled' : ''}>${extracting ? '<span class="spin"></span>Extracting…' : 'Re-extract'}</button>
    </div>
    <div class="review">
      <div class="review-left">${viewer}</div>
      <div class="review-right">
        ${extracting ? '<div class="empty"><span class="spin"></span>Reading the document and extracting its data — this can take up to half a minute…</div>' : ''}
        ${doc.error ? `<div class="meta-line" style="color:var(--red)">Last error: ${esc(doc.error)}</div>` : ''}
        ${ex._method ? `<div class="meta-line">Extracted via <b>${esc(ex._method)}</b>${ex._confidence != null ? ` · parser confidence ${Math.round(ex._confidence * 100)}%` : ''}${low.size ? ` · check highlighted fields` : ''}</div>` : ''}
        <div class="section-title">Header</div>
        <div class="grid2">
          <div class="field ${low.has('doc_type') ? 'warn' : ''}">
            <label>Document type</label>
            <select data-key="doc_type">
              <option value="purchase_request" ${ex.doc_type !== 'service_request' ? 'selected' : ''}>Purchase Request</option>
              <option value="service_request" ${ex.doc_type === 'service_request' ? 'selected' : ''}>Service Request</option>
            </select>
          </div>
          ${fieldHtml('PR/SR number', 'number', ex.number, { warn: low.has('number') || !ex.number })}
          ${fieldHtml('Date (DD/MM/YYYY)', 'date', ex.date, { warn: low.has('date') || !ex.date })}
          ${fieldHtml('Requester', 'requester_name', ex.requester_name, { warn: low.has('requester_name') })}
          ${fieldHtml('Phone', 'requester_phone', ex.requester_phone, { warn: low.has('requester_phone') })}
          ${fieldHtml('Department', 'department', ex.department, { warn: low.has('department') || !ex.department })}
          ${fieldHtml('Project', 'project', ex.project, { warn: low.has('project') })}
          <div class="field ${low.has('project_site') ? 'warn' : ''}">
            <label>Project site</label>
            <select data-key="project_site">
              ${['', 'KAR 1', 'KAR 2', 'KAR 3'].map((s) => `<option value="${s}" ${ex.project_site === s ? 'selected' : ''}>${s || '—'}</option>`).join('')}
            </select>
          </div>
          ${fieldHtml('Priority', 'priority', ex.priority, { warn: low.has('priority') })}
          ${fieldHtml('Purchase type', 'purchase_type', ex.purchase_type, { warn: low.has('purchase_type') })}
        </div>
        <div class="field ${low.has('note') ? 'warn' : ''}" style="margin-top:10px">
          <label>Note</label>
          <textarea data-key="note" rows="2">${esc(ex.note ?? '')}</textarea>
        </div>

        <div class="section-title">Line items (${items.length}) <button class="btn" id="btn-add-item" style="padding:2px 10px;font-size:11px;margin-left:8px">+ row</button></div>
        <table class="items">
          <thead><tr><th style="width:26px">#</th><th>Description</th><th style="width:64px">Qty</th><th style="width:74px">UoM</th><th style="width:110px">Sage code</th><th>Purpose</th><th style="width:26px"></th></tr></thead>
          <tbody id="items-body">
            ${items.map((li, i) => `
              <tr data-i="${i}">
                <td style="color:var(--muted);font-size:12px">${i + 1}</td>
                <td><input data-li="description" value="${esc(li.description ?? '')}" /></td>
                <td><input data-li="qty" type="number" value="${esc(li.qty ?? '')}" class="${li.qty > 0 ? '' : 'warn'}" /></td>
                <td><input data-li="uom" value="${esc(li.uom ?? '')}" /></td>
                <td><input data-li="sage_code" value="${esc(li.sage_code ?? '')}" class="${sageOk(li.sage_code) ? '' : 'warn'}" /></td>
                <td><input data-li="purpose" value="${esc(li.purpose ?? '')}" /></td>
                <td><button class="btn danger" data-del="${i}" style="padding:2px 7px;font-size:11px">✕</button></td>
              </tr>`).join('')}
          </tbody>
        </table>

        <div class="section-title">Approval chain</div>
        <div class="approvals">
          ${(ex.approvals || []).map((a) => `✓ ${esc(a.name)} — ${esc(a.status)} ${esc(a.timestamp || '')}`).join('<br>') || '<span style="color:var(--muted)">None detected</span>'}
        </div>

        <div class="section-title">Supplier (QuickBooks vendor)</div>
        <div class="field">
          <select id="vendor-select">
            <option value="">— placeholder vendor (UNKNOWN) —</option>
            ${(state.qbVendors || []).map((v) => `<option value="${esc(v.id)}" ${doc.vendorId === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
            ${state.qbVendors == null ? '<option disabled>Loading vendor list…</option>' : ''}
          </select>
          <div class="hint">The market supplier this bill is payable to. Leave as placeholder if unknown — the team reassigns it in QuickBooks later.</div>
        </div>
        ${doc.qb ? `<div class="section-title">QuickBooks</div><div class="approvals">Pushed ${new Date(doc.qb.pushedAt).toLocaleString()} — ${doc.qb.mock ? 'MOCK entry' : 'Bill Id ' + esc(doc.qb.billId)} ${doc.qb.payloadPath ? `· <a href="#" id="open-payload">view payload</a>` : ''}</div>` : ''}
        ${doc.driveFile ? `<div class="approvals" style="margin-top:6px">Archived to Drive: ${esc(doc.driveFile.path)}</div>` : ''}
      </div>
    </div>
    <div class="review-actions">
      <button class="btn green" id="btn-approve" ${doc.status === 'pushed' || state.busy ? 'disabled' : ''}>✔ Approve &amp; push to QuickBooks</button>
      <button class="btn" id="btn-save">Save corrections</button>
      <button class="btn" id="btn-flag">🚩 Flag</button>
      <button class="btn" id="btn-skip">Skip</button>
      <span style="flex:1"></span>
      <button class="btn danger" id="btn-delete">Delete</button>
    </div>`;

  $('#btn-back').onclick = () => { state.view = 'queue'; render(); };
  $('#btn-reextract').onclick = () => extractNow(doc.id);

  const vendorSel = $('#vendor-select');
  vendorSel.onchange = () => {
    const name = vendorSel.selectedOptions[0]?.textContent || null;
    window.api.docs.setVendor(doc.id, vendorSel.value ? { vendorId: vendorSel.value, vendorName: name } : null)
      .catch((err) => pushStatus(`Could not set vendor: ${err.message}`, 'error'));
  };
  // Vendor list loads once per session, lazily, from the connected company.
  if (state.qbVendors == null && !state.qbVendorsLoading) {
    state.qbVendorsLoading = true;
    window.api.qb.vendors()
      .then((v) => { state.qbVendors = v; })
      .catch(() => { state.qbVendors = []; })
      .finally(() => {
        state.qbVendorsLoading = false;
        if (state.view === 'review' && state.selectedId === doc.id) renderReview(doc);
      });
  }
  $('#open-payload')?.addEventListener('click', (e) => { e.preventDefault(); window.api.app.openPath(doc.qb.payloadPath); });

  const collect = () => {
    const out = { ...ex };
    $$('.review-right [data-key]').forEach((el) => { out[el.dataset.key] = el.value === '' ? null : el.value; });
    out.line_items = $$('#items-body tr').map((tr, i) => {
      const li = {};
      $$('input[data-li]', tr).forEach((el) => {
        li[el.dataset.li] = el.dataset.li === 'qty'
          ? (el.value === '' ? null : Number(el.value))
          : (el.value === '' ? null : el.value);
      });
      li.no = i + 1;
      return li;
    });
    return out;
  };

  const save = async () => {
    const updated = collect();
    await window.api.docs.updateExtraction(doc.id, updated);
    pushStatus('Corrections saved');
    return updated;
  };

  $('#btn-save').onclick = () => save().then(() => renderReview());
  $('#btn-add-item').onclick = async () => {
    const updated = collect();
    updated.line_items.push({ no: updated.line_items.length + 1, description: '', qty: null, uom: 'Piece', sage_code: '', purpose: '' });
    await window.api.docs.updateExtraction(doc.id, updated);
    renderReview();
  };
  $$('#items-body [data-del]').forEach((b) => b.onclick = async () => {
    const updated = collect();
    updated.line_items.splice(Number(b.dataset.del), 1);
    await window.api.docs.updateExtraction(doc.id, updated);
    renderReview();
  });
  $('#btn-flag').onclick = async () => { await save(); await window.api.docs.setStatus(doc.id, 'flagged'); state.view = 'queue'; render(); };
  $('#btn-skip').onclick = async () => { await save(); await window.api.docs.setStatus(doc.id, 'skipped'); state.view = 'queue'; render(); };
  $('#btn-delete').onclick = async () => {
    if (!confirm('Delete this document from the queue?')) return;
    await window.api.docs.remove(doc.id);
    state.view = 'queue'; render();
  };
  $('#btn-approve').onclick = (e) => withSpinner(e.currentTarget, 'Pushing to QuickBooks…', async () => {
    state.busy = true;
    try {
      await save();
      const updated = await window.api.qb.push(doc.id);
      pushStatus(updated.qb.mock
        ? `MOCK: Bill payload written (${updated.qb.billId})`
        : `Pushed to QuickBooks — Bill Id ${updated.qb.billId}${updated.qb.attachmentError ? ` (attachment failed: ${updated.qb.attachmentError})` : ''}`);
      state.busy = false;
      renderReview(updated);
    } catch (err) {
      state.busy = false;
      pushStatus(`Push failed: ${err.message}`, 'error');
      renderReview();
    }
  });
}

// ============================================================ SETTINGS
function sInput(label, key, value, { type = 'text', placeholder = '' } = {}) {
  return `
    <div class="field">
      <label>${label}</label>
      <input type="${type}" data-s="${key}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" />
    </div>`;
}

async function renderSettings() {
  const s = state.settings = await window.api.settings.get();
  const qbSt = await window.api.qb.status();
  const drSt = await window.api.drive.status();
  const main = $('#main');

  main.innerHTML = `
    <div class="toolbar"><h1>Settings</h1><button class="btn primary" id="btn-save-settings">Save settings</button></div>
    <div class="scroll">

      <div class="settings-card">
        <h2>Email intake (IMAP)</h2>
        <div class="hint">The app polls this inbox and pulls PDF/image attachments from authorized senders into the queue. Use a dedicated mailbox (e.g. docs@bluerocktradingltd.com). For Gmail, use an App Password.</div>
        <div class="inline" style="margin-bottom:10px">
          <label><input type="checkbox" data-s="email.enabled" ${s.email.enabled ? 'checked' : ''}/> Enable email polling</label>
          <span class="badge">every <input type="number" data-s="general.pollMinutes" value="${s.general.pollMinutes}" style="width:52px;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:2px 6px"> min</span>
        </div>
        <div class="grid2">
          ${sInput('IMAP host', 'email.host', s.email.host, { placeholder: 'mail.bluerocktradingltd.com' })}
          ${sInput('Port', 'email.port', s.email.port, { type: 'number' })}
          ${sInput('Username', 'email.user', s.email.user, { placeholder: 'docs@bluerocktradingltd.com' })}
          ${sInput('Password', 'email.password', s.email.password, { type: 'password' })}
        </div>
        <div class="field">
          <label>Authorized sender emails (one per line — leave empty to accept all)</label>
          <textarea data-s="general.authorizedSenders" rows="3" placeholder="someone@karbusiness.com">${esc((s.general.authorizedSenders || []).join('\n'))}</textarea>
        </div>
      </div>

      <div class="settings-card">
        <h2>AI extraction</h2>
        <div class="hint">All documents are extracted with AI by default (typed PDFs as text, photos/scans as vision). The local no-AI parser is available as a cost saver via the option below. Keys are stored encrypted in the OS keychain-backed store.</div>
        <div class="grid2">
          <div class="field"><label>Provider</label>
            <select data-s="ai.provider">
              <option value="anthropic" ${s.ai.provider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option>
              <option value="openai" ${s.ai.provider === 'openai' ? 'selected' : ''}>OpenAI (GPT)</option>
            </select>
          </div>
          <div class="field"><label>Use AI for typed PDFs</label>
            <select data-s="ai.useAiForTypedPdfs">
              <option value="always" ${s.ai.useAiForTypedPdfs === 'always' ? 'selected' : ''}>Always (recommended)</option>
              <option value="auto" ${s.ai.useAiForTypedPdfs === 'auto' ? 'selected' : ''}>Auto (parser first, AI fallback)</option>
              <option value="never" ${s.ai.useAiForTypedPdfs === 'never' ? 'selected' : ''}>Never (local only)</option>
            </select>
          </div>
          ${sInput('Anthropic API key', 'ai.anthropicKey', s.ai.anthropicKey, { type: 'password', placeholder: 'sk-ant-…' })}
          ${sInput('Anthropic model', 'ai.anthropicModel', s.ai.anthropicModel)}
          ${sInput('OpenAI API key', 'ai.openaiKey', s.ai.openaiKey, { type: 'password', placeholder: 'sk-…' })}
          ${sInput('OpenAI model', 'ai.openaiModel', s.ai.openaiModel)}
        </div>
      </div>

      <div class="settings-card">
        <h2>QuickBooks Online <span class="badge ${qbSt.connected ? 'on' : 'off'}">${qbSt.connected ? `connected (realm ${esc(qbSt.realmId)})` : 'not connected'}</span></h2>
        <div class="hint">Mock mode needs no Intuit account: approved entries are written as Bill payload JSON files you can inspect (qb-outbox). Sandbox/production use your Intuit developer app credentials. Bills are created at $0.00 in review-pending state — your team adds cost, margin and final categories in QBO.</div>
        <div class="grid2">
          <div class="field"><label>Mode</label>
            <select data-s="qb.mode">
              <option value="mock" ${s.qb.mode === 'mock' ? 'selected' : ''}>Mock (no QuickBooks)</option>
              <option value="sandbox" ${s.qb.mode === 'sandbox' ? 'selected' : ''}>Sandbox</option>
              <option value="production" ${s.qb.mode === 'production' ? 'selected' : ''}>Production</option>
            </select>
          </div>
          ${sInput('Default vendor Id (auto-resolves to UNKNOWN on connect)', 'qb.vendorId', s.qb.vendorId)}
          ${sInput('Client ID', 'qb.clientId', s.qb.clientId)}
          ${sInput('Client Secret', 'qb.clientSecret', s.qb.clientSecret, { type: 'password' })}
          ${sInput('Default vendor name', 'qb.vendorName', s.qb.vendorName)}
          ${sInput('OAuth redirect port (sandbox)', 'qb.redirectPort', s.qb.redirectPort, { type: 'number' })}
          ${sInput('Production redirect URI (registered HTTPS callback page)', 'qb.productionRedirectUri', s.qb.productionRedirectUri)}
        </div>
        <div class="section-title">Sage prefix → QBO account Id</div>
        <div class="grid2">
          ${Object.keys(s.qb.accountMap).map((k) => sInput(k, `qb.accountMap.${k}`, s.qb.accountMap[k])).join('')}
          ${sInput('Default account Id (fallback)', 'qb.defaultAccountId', s.qb.defaultAccountId)}
        </div>
        <div class="inline" style="margin-top:8px">
          <button class="btn" id="btn-qb-connect">Connect to QuickBooks…</button>
        </div>
        <details style="margin-top:10px">
          <summary style="cursor:pointer;color:var(--muted);font-size:12.5px">Manual code entry (production — Intuit requires an HTTPS redirect, so paste the code &amp; realmId from your callback page)</summary>
          <div class="grid2" style="margin-top:10px">
            <div class="field"><label>Authorization code</label><input id="qb-manual-code" /></div>
            <div class="field"><label>Realm Id</label><input id="qb-manual-realm" /></div>
            <div class="field" style="grid-column:1/-1"><label>Redirect URI used at sign-in (defaults to the production redirect URI above)</label><input id="qb-manual-redirect" value="${esc(s.qb.productionRedirectUri || '')}" /></div>
          </div>
          <button class="btn" id="btn-qb-manual">Exchange code</button>
        </details>
      </div>

      <div class="settings-card">
        <h2>Google Drive archive <span class="badge ${drSt.connected ? 'on' : 'off'}">${drSt.connected ? 'connected' : 'not connected'}</span></h2>
        <div class="hint">Optional. When enabled, the original document + extracted JSON are filed to Drive under /KAR/[Department]/[Year-Month]/ after each push. The app works fully without it — nothing is stored in the cloud unless you turn this on. Requires a Google Cloud OAuth "Desktop app" client with the consent screen published to Production.</div>
        <div class="inline" style="margin-bottom:10px">
          <label><input type="checkbox" data-s="drive.enabled" ${s.drive.enabled ? 'checked' : ''}/> Enable Drive archival</label>
        </div>
        <div class="grid2">
          ${sInput('Client ID', 'drive.clientId', s.drive.clientId)}
          ${sInput('Client Secret', 'drive.clientSecret', s.drive.clientSecret, { type: 'password' })}
          ${sInput('Root folder name', 'drive.rootFolderName', s.drive.rootFolderName)}
          ${sInput('OAuth redirect port', 'drive.redirectPort', s.drive.redirectPort, { type: 'number' })}
        </div>
        <button class="btn" id="btn-drive-connect">Connect to Google Drive…</button>
      </div>
      <div class="settings-card">
        <h2>Support</h2>
        <div class="hint">Questions or problems? Email <a href="mailto:david@mindsheep.com.au">david@mindsheep.com.au</a>.
        If something failed, attach the error log — <a href="#" id="btn-open-log">open log folder</a> — it contains the
        details (including QuickBooks intuit_tid references) needed to troubleshoot quickly.</div>
      </div>
    </div>`;

  $('#btn-open-log').onclick = (e) => {
    e.preventDefault();
    window.api.app.openLog().catch((err) => pushStatus(`Could not open log: ${err.message}`, 'error'));
  };

  // Persist everything currently typed into the form. Connect/exchange actions
  // call this first so they always act on what the user sees — clicking
  // "Connect" with an unsaved Client ID (or Mode) must never use stale values.
  const saveForm = async () => {
    const patch = {};
    $$('#main [data-s]').forEach((el) => {
      const keys = el.dataset.s.split('.');
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.type === 'number') value = Number(el.value);
      // Trim pasted values — an invisible trailing newline in a credential
      // (Client ID, API key) makes OAuth requests malformed (Google 400s).
      else value = el.value.trim();
      if (el.dataset.s === 'general.authorizedSenders') {
        value = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
      }
      let o = patch;
      for (const k of keys.slice(0, -1)) o = o[k] ?? (o[k] = {});
      o[keys[keys.length - 1]] = value;
    });
    await window.api.settings.set(patch);
  };

  $('#btn-save-settings').onclick = (e) => withSpinner(e.currentTarget, 'Saving…', async () => {
    try {
      await saveForm();
      pushStatus('Settings saved');
      renderSettings();
    } catch (err) { pushStatus(`Save failed: ${err.message}`, 'error'); }
  });

  $('#btn-qb-connect').onclick = (e) => withSpinner(e.currentTarget, 'Waiting for QuickBooks sign-in…', async () => {
    try {
      await saveForm();
      const res = await window.api.qb.connect();
      pushStatus(res.connected ? `QuickBooks connected (realm ${res.realmId})` : res.message);
    } catch (err) { pushStatus(`QuickBooks connect failed: ${err.message}`, 'error'); }
    renderSettings();
  });
  $('#btn-qb-manual').onclick = (e) => withSpinner(e.currentTarget, 'Exchanging code…', async () => {
    try {
      await saveForm();
      const res = await window.api.qb.connectManual({
        code: $('#qb-manual-code').value.trim(),
        realmId: $('#qb-manual-realm').value.trim(),
        redirectUri: $('#qb-manual-redirect').value.trim(),
      });
      pushStatus(`QuickBooks connected (realm ${res.realmId})`);
    } catch (err) { pushStatus(`QuickBooks connect failed: ${err.message}`, 'error'); }
    renderSettings();
  });
  $('#btn-drive-connect').onclick = (e) => withSpinner(e.currentTarget, 'Waiting for Google sign-in…', async () => {
    try {
      await saveForm();
      await window.api.drive.connect();
      pushStatus('Google Drive connected');
    } catch (err) { pushStatus(`Drive connect failed: ${err.message}`, 'error'); }
    renderSettings();
  });
}

// ---------- boot ----------
(async () => {
  const splashStart = Date.now();
  await refreshDocs();
  render();
  const v = await window.api.app.versions();
  pushStatus(`Blue Rock Procurement v${v.app} (Electron ${v.electron})`);
  // Hold the splash a moment so the intro reads as intentional, not a flash.
  const splash = $('#splash');
  setTimeout(() => {
    splash.classList.add('hide');
    setTimeout(() => splash.remove(), 500);
  }, Math.max(0, 1400 - (Date.now() - splashStart)));
})();
