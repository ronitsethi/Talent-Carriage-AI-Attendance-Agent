const $ = (id) => document.getElementById(id);

const STATUS = {
  new:       { cls: 'waiting', label: 'Queued' },
  sent:      { cls: 'waiting', label: 'Sent · awaiting reply' },
  delivered: { cls: 'waiting', label: 'Delivered · awaiting reply' },
  read:      { cls: 'waiting', label: 'Read · awaiting reply' },
  replied:   { cls: 'done',    label: 'Replied · guidance sent' },
  needs_hr:  { cls: 'pending', label: 'Unclear reply · HR check' },
  no_reply:  { cls: 'call',    label: 'No reply' },
  failed:    { cls: 'call',    label: 'Send failed' },
};
const WAITING = ['sent', 'delivered', 'read'];

let meta = null;
let cases = [];
let unsent = [];
let selectedId = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function notice(el, kind, text) {
  el.innerHTML = text ? `<div class="notice ${kind}">${esc(text)}</div>` : '';
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---------- header ----------
function renderFlags(settings) {
  const f = [];
  f.push(meta.dryRun
    ? '<span class="flag warn">◷ WhatsApp dry run: nothing is sent</span>'
    : '<span class="flag ok">✓ WhatsApp live</span>');
  f.push(meta.aiEnabled
    ? '<span class="flag ok">✓ AI reply classification on</span>'
    : '<span class="flag idle">AI reply classification off</span>');
  f.push(settings.scheduler_enabled === 'true'
    ? `<span class="flag ok">✓ Daily check at ${esc(settings.check_time)}</span>`
    : '<span class="flag idle">Daily check off</span>');
  f.push(`<span class="flag idle">${meta.data.employees} employees in database</span>`);
  $('flags').innerHTML = f.join('');
}

function renderStats() {
  const count = (fn) => cases.filter(fn).length;
  $('statTotal').textContent = cases.length;
  $('statWaiting').textContent = count((c) => WAITING.includes(c.status) || c.status === 'new');
  $('statLeave').textContent = count((c) => c.reply_option === 1);
  $('statReg').textContent = count((c) => c.reply_option === 2);
  $('statMgr').textContent = count((c) => c.reply_option === 3 || c.reply_option === 4);
  $('statAttention').textContent = count((c) => ['needs_hr', 'no_reply', 'failed'].includes(c.status));
}

// ---------- cases ----------
function nextStep(c) {
  if (c.status === 'failed' || c.status === 'new') {
    return `<button class="btn small primary" data-act="send" data-id="${c.id}" type="button">Retry send</button>`;
  }
  if (WAITING.includes(c.status)) {
    return `<button class="btn small" data-act="noreply" data-id="${c.id}" type="button">Mark no reply</button>`;
  }
  if (c.status === 'needs_hr') return '<span class="sub">Check reply</span>';
  if (c.status === 'no_reply') return '<span class="sub">Stage 2 (not in demo)</span>';
  return '<span class="sub">Done</span>';
}

function renderCases() {
  const body = $('caseBody');
  if (!cases.length && !unsent.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">${$('allDates').checked
      ? 'No cases yet. Run a check above.'
      : 'Nobody is marked absent or half-day on this date.'}</td></tr>`;
    return;
  }
  const unsentRows = unsent.map((f) => `<tr class="unsent">
      <td><div class="employee">${esc(f.full_name)}</div><div class="sub">${esc(f.department || '—')} · ${esc(f.manager || '—')}</div></td>
      <td class="date">${esc(f.date_label)}<div class="sub"><span class="pill pending">${esc(f.code)}</span></div></td>
      <td><span class="pill pending">Not messaged yet</span></td>
      <td><span class="sub">–</span></td>
      <td><span class="sub">Run check &amp; send</span></td>
    </tr>`);
  body.innerHTML = unsentRows.join('') + cases.map((c) => {
    const st = STATUS[c.status] || { cls: 'waiting', label: c.status };
    const ai = c.ai_used ? ' <span class="pill waiting" title="Classified by AI">AI</span>' : '';
    const reply = c.reply_label
      ? `${esc(c.reply_label)}${ai}<div class="sub">→ ${esc(c.action)}</div>`
      : c.reply_text ? `“${esc(c.reply_text)}”${ai}` : '<span class="sub">–</span>';
    return `<tr data-id="${c.id}" class="${c.id === selectedId ? 'selected' : ''}">
      <td><div class="employee">${esc(c.full_name)}</div><div class="sub">${esc(c.department || '—')} · ${esc(c.manager || '—')}</div></td>
      <td class="date">${esc(c.date_label)}<div class="sub"><span class="pill pending">${esc(c.code)}</span></div></td>
      <td><span class="pill ${st.cls}" title="${esc(c.error || '')}">${esc(st.label)}</span></td>
      <td>${reply}</td>
      <td>${nextStep(c)}</td>
    </tr>`;
  }).join('');
}

async function loadCases() {
  const date = $('checkDate').value;
  const single = !$('allDates').checked && date;
  cases = await api(`/api/cases${single ? `?date=${date}` : ''}`);
  // For a single date, also list absentees who haven't been messaged yet.
  unsent = single ? (await api(`/api/preview?date=${date}`)).flagged.filter((f) => !f.case_id) : [];
  renderCases();
  renderStats();
}

// ---------- conversation ----------
async function loadChat() {
  if (!selectedId) return;
  const c = cases.find((x) => x.id === selectedId);
  if (!c) return;
  const data = await api(`/api/cases/${selectedId}/messages`);
  $('chatTitle').textContent = c.full_name;
  $('chatNote').textContent = `${c.date_label} · ${c.code} · +${c.mobile_e164 || 'no number'}`;
  const bubbles = data.messages.length
    ? data.messages.map((m) => `<div class="bubble ${m.direction}">${esc(m.body)}<span class="meta">${fmtTime(m.created_at)} · ${esc(m.status || '')}</span></div>`)
    : [`<div class="bubble out">${esc(data.preview)}<span class="meta">preview · not sent yet</span></div>`];
  const chat = $('chat');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.innerHTML = bubbles.join('');
  if (atBottom) chat.scrollTop = chat.scrollHeight;
  $('simBox').hidden = !(meta.dryRun && c.status !== 'new' && c.status !== 'failed');
}

function selectCase(id) {
  selectedId = id;
  renderCases();
  loadChat().catch(console.error);
  if (window.innerWidth < 980) $('whatsapp').scrollIntoView();
}

async function simulate(payload) {
  if (!selectedId) return;
  try {
    await api(`/api/cases/${selectedId}/simulate`, { method: 'POST', body: JSON.stringify(payload) });
    await loadCases();
    await loadChat();
  } catch (err) {
    alert(err.message);
  }
}

// ---------- run check ----------
async function preview() {
  const date = $('checkDate').value;
  const box = $('previewList');
  notice($('runNotice'), '', '');
  const data = await api(`/api/preview?date=${date}`);
  box.hidden = false;
  if (!data.flagged.length) {
    box.innerHTML = '<h3>Nobody is marked absent or half-day on this date.</h3>';
    return data;
  }
  const fresh = data.flagged.filter((f) => !f.case_id).length;
  box.innerHTML = `<h3>${data.flagged.length} flagged · ${fresh} will be messaged</h3>` + data.flagged.map((f) =>
    `<div class="preview-row"><span><b>${esc(f.full_name)}</b> <span class="sub">+${esc(f.mobile_e164 || 'no number')}</span></span>
     <span><span class="pill pending">${esc(f.code)}</span> ${f.case_id ? `<span class="pill done">${esc((STATUS[f.case_status] || {}).label || f.case_status)}</span>` : ''}</span></div>`).join('');
  return data;
}

async function run() {
  const date = $('checkDate').value;
  const btn = $('runBtn');
  btn.disabled = true;
  try {
    const data = await preview();
    const fresh = data.flagged.filter((f) => !f.case_id);
    if (!fresh.length) {
      notice($('runNotice'), 'info', data.flagged.length ? 'Everyone flagged on this date has already been messaged.' : 'Nothing to send.');
      return;
    }
    const names = fresh.map((f) => `• ${f.full_name} (+${f.mobile_e164})`).join('\n');
    const mode = meta.dryRun ? 'DRY RUN: messages are logged, not sent.' : 'LIVE: real WhatsApp messages will be sent.';
    if (!confirm(`${mode}\n\nSend the attendance message to ${fresh.length} employee(s)?\n\n${names}`)) return;
    btn.textContent = 'Sending…';
    const r = await api('/api/run', { method: 'POST', body: JSON.stringify({ date }) });
    notice($('runNotice'), r.failed ? 'err' : 'ok',
      `Sent ${r.sent}${r.failed ? ` · ${r.failed} failed` : ''}${r.skipped ? ` · ${r.skipped} already had a case` : ''}${meta.dryRun ? ' (dry run)' : ''}.`);
    $('allDates').checked = false;
    await loadCases();
    await preview();
  } catch (err) {
    notice($('runNotice'), 'err', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run check & send';
  }
}

// ---------- settings / import ----------
async function loadSettings() {
  const s = await api('/api/settings');
  $('checkTime').value = s.check_time;
  $('schedEnabled').checked = s.scheduler_enabled === 'true';
  renderFlags(s);
  return s;
}

async function saveSettings() {
  try {
    const s = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ check_time: $('checkTime').value, scheduler_enabled: $('schedEnabled').checked }),
    });
    renderFlags(s);
    $('settingsNote').textContent = s.scheduler_enabled === 'true'
      ? `Saved. The check runs daily at ${s.check_time} IST for that day's attendance.`
      : 'Saved. Automatic check is off; use "Run check & send".';
  } catch (err) {
    $('settingsNote').textContent = err.message;
  }
}

async function importFile() {
  const file = $('fileInput').files[0];
  if (!file) return notice($('importNotice'), 'err', 'Choose a file first.');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await api('/api/import', { method: 'POST', body: fd });
    notice($('importNotice'), 'ok', `Imported ${r.employees} employees, ${r.attendanceRows} attendance entries (${r.from} to ${r.to}).`);
    await init();
  } catch (err) {
    notice($('importNotice'), 'err', err.message);
  }
}

// ---------- wiring ----------
$('caseBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    e.stopPropagation();
    const id = Number(btn.dataset.id);
    try {
      if (btn.dataset.act === 'send') await api(`/api/cases/${id}/send`, { method: 'POST' });
      if (btn.dataset.act === 'noreply') await api(`/api/cases/${id}/no-reply`, { method: 'POST' });
    } catch (err) {
      alert(err.message);
    }
    await loadCases();
    if (id === selectedId) loadChat();
    return;
  }
  const row = e.target.closest('tr[data-id]');
  if (row) selectCase(Number(row.dataset.id));
});
$('previewBtn').addEventListener('click', () => preview().catch((err) => notice($('runNotice'), 'err', err.message)));
$('runBtn').addEventListener('click', run);
$('checkDate').addEventListener('change', () => { $('previewList').hidden = true; loadCases(); });
$('allDates').addEventListener('change', loadCases);
$('saveSettings').addEventListener('click', saveSettings);
$('importBtn').addEventListener('click', importFile);
$('simSend').addEventListener('click', () => {
  const text = $('simText').value.trim();
  if (text) { simulate({ text }); $('simText').value = ''; }
});
$('simText').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('simSend').click(); });

async function init() {
  meta = await api('/api/meta');
  const { min, max } = meta.data;
  $('dataRange').textContent = min ? `Data available ${min} to ${max}` : 'No attendance imported yet';
  const urlDate = new URLSearchParams(location.search).get('date');
  if (urlDate) $('checkDate').value = urlDate;
  if (!$('checkDate').value) {
    // Demo data is historical: default to today if it has data, otherwise the latest imported day.
    $('checkDate').value = max && meta.today > max ? max : meta.today;
  }
  $('webhookUrl').textContent = `${location.origin}/webhook`;
  $('templateName').textContent = meta.templateName;
  $('simButtons').innerHTML = Object.entries(meta.options).map(([n, o]) =>
    `<button class="btn small" type="button" data-opt="${n}">${n} · ${esc(o.button)}</button>`).join('');
  $('simButtons').onclick = (e) => {
    const b = e.target.closest('button[data-opt]');
    if (b) simulate({ option: Number(b.dataset.opt) });
  };
  $('chat').innerHTML = '<div class="bubble out">Select a case in the table to see its WhatsApp conversation.</div>';
  await loadSettings();
  await loadCases();
}

init().catch((err) => alert(`Failed to load: ${err.message}`));

// Live updates while replies arrive through the webhook.
setInterval(() => {
  if (document.hidden) return;
  loadCases().then(loadChat).catch(console.error);
}, 5000);
