import { q } from './db.js';
import { absentDateLabel, firstName, firstMessage, systemReply, clarifyMessage, OPTIONS } from './flow.js';
import { sendAbsentTemplate, sendText } from './whatsapp.js';
import { classifyReply } from './classifier.js';

// Statuses where we are still waiting for the employee's answer.
const OPEN = ['sent', 'delivered', 'read', 'needs_hr', 'no_reply'];
const DELIVERY_RANK = { new: 0, sent: 1, delivered: 2, read: 3 };

const CASE_SELECT = `
  SELECT c.*, e.emp_code, e.full_name, e.department, e.branch, e.manager, e.mobile, e.mobile_e164
  FROM cases c JOIN employees e ON e.id = c.employee_id`;

export async function getCase(id) {
  const { rows } = await q(`${CASE_SELECT} WHERE c.id = $1`, [id]);
  return rows[0] || null;
}

export async function listCases(date) {
  const { rows } = date
    ? await q(`${CASE_SELECT} WHERE c.absent_date = $1 ORDER BY e.full_name`, [date])
    : await q(`${CASE_SELECT} ORDER BY c.absent_date DESC, e.full_name`);
  return rows.map(decorate);
}

function decorate(c) {
  return {
    ...c,
    date_label: absentDateLabel(c.absent_date, c.code),
    action: c.reply_option ? OPTIONS[c.reply_option].action : null,
    reply_label: c.reply_option ? `${c.reply_option} · ${OPTIONS[c.reply_option].button}` : null,
  };
}

async function logMessage({ caseId, direction, waMessageId, waId, body, status, payload }) {
  const { rowCount } = await q(
    `INSERT INTO messages (case_id, direction, wa_message_id, wa_id, body, status, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (wa_message_id) DO NOTHING`,
    [caseId, direction, waMessageId, waId, body, status, payload ? JSON.stringify(payload) : null],
  );
  return rowCount > 0;
}

// Everyone marked A|A, A|P or P|A on a date, plus any case already created for them.
export async function findFlagged(date) {
  const { rows } = await q(
    `SELECT e.id AS employee_id, e.emp_code, e.full_name, e.department, e.manager, e.mobile, e.mobile_e164,
            a.first_half || '|' || a.second_half AS code,
            c.id AS case_id, c.status AS case_status
     FROM attendance a
     JOIN employees e ON e.id = a.employee_id
     LEFT JOIN cases c ON c.employee_id = e.id AND c.absent_date = a.att_date
     WHERE a.att_date = $1
       AND (a.first_half, a.second_half) IN (('A','A'), ('A','P'), ('P','A'))
     ORDER BY e.full_name`,
    [date],
  );
  return rows.map((r) => ({ ...r, date_label: absentDateLabel(date, r.code) }));
}

export async function sendFirstMessage(caseId) {
  const c = await getCase(caseId);
  if (!c) throw new Error(`Case ${caseId} not found`);
  const dateLabel = absentDateLabel(c.absent_date, c.code);
  const name = firstName(c.full_name);
  const body = firstMessage(name, dateLabel);

  if (!c.mobile_e164) {
    await q(`UPDATE cases SET status = 'failed', error = 'No mobile number' WHERE id = $1`, [caseId]);
    return { ok: false, error: 'No mobile number' };
  }
  try {
    const res = await sendAbsentTemplate(c.mobile_e164, { name, dateLabel, caseId });
    await q(
      `UPDATE cases SET status = 'sent', wa_message_id = $2, sent_at = now(), error = NULL WHERE id = $1`,
      [caseId, res.id],
    );
    await logMessage({ caseId, direction: 'out', waMessageId: res.id, waId: c.mobile_e164, body, status: res.dryRun ? 'dry-run' : 'sent' });
    return { ok: true, id: res.id, dryRun: res.dryRun };
  } catch (err) {
    await q(`UPDATE cases SET status = 'failed', error = $2 WHERE id = $1`, [caseId, err.message]);
    await logMessage({ caseId, direction: 'out', waMessageId: null, waId: c.mobile_e164, body, status: `failed: ${err.message}` });
    return { ok: false, error: err.message };
  }
}

// Creates cases for a date and sends the first WhatsApp to each new one.
// Existing cases are never re-sent (UNIQUE employee_id + absent_date).
export async function runCheck(date, { source = 'manual' } = {}) {
  const flagged = await findFlagged(date);
  const results = [];
  for (const f of flagged) {
    const { rows } = await q(
      `INSERT INTO cases (employee_id, absent_date, code) VALUES ($1,$2,$3)
       ON CONFLICT (employee_id, absent_date) DO NOTHING RETURNING id`,
      [f.employee_id, date, f.code],
    );
    if (!rows.length) {
      results.push({ name: f.full_name, skipped: true, reason: 'already has a case' });
      continue;
    }
    const r = await sendFirstMessage(rows[0].id);
    results.push({ name: f.full_name, caseId: rows[0].id, ...r });
  }
  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => r.ok === false).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`[run:${source}] ${date}: flagged=${flagged.length} sent=${sent} failed=${failed} skipped=${skipped}`);
  return { date, flagged: flagged.length, sent, failed, skipped, results };
}

function textOf(m) {
  if (m.type === 'text') return m.text?.body ?? '';
  if (m.type === 'button') return m.button?.text ?? '';
  if (m.type === 'interactive') return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
  return `[${m.type}]`;
}

function payloadOf(m) {
  const p = m.button?.payload ?? m.interactive?.button_reply?.id;
  const match = /^case:(\d+):([1-4])$/.exec(p || '');
  return match ? { caseId: Number(match[1]), option: Number(match[2]) } : null;
}

async function resolveCase(m, payload) {
  if (payload) {
    const c = await getCase(payload.caseId);
    if (c && c.mobile_e164 === m.from) return c;
  }
  if (m.context?.id) {
    const { rows } = await q(`${CASE_SELECT} WHERE c.wa_message_id = $1 AND e.mobile_e164 = $2`, [m.context.id, m.from]);
    if (rows[0]) return rows[0];
  }
  // Free text without a quoted message: latest case still waiting on this number.
  const { rows } = await q(
    `${CASE_SELECT} WHERE e.mobile_e164 = $1 AND c.status = ANY($2) ORDER BY c.sent_at DESC NULLS LAST LIMIT 1`,
    [m.from, OPEN],
  );
  return rows[0] || null;
}

// Handles one incoming WhatsApp message (from the webhook or the demo simulator).
export async function handleInbound(m) {
  const text = textOf(m);
  const payload = payloadOf(m);
  const fresh = await logMessage({ caseId: null, direction: 'in', waMessageId: m.id, waId: m.from, body: text, status: 'received', payload: m });
  if (!fresh) return { duplicate: true };

  const c = await resolveCase(m, payload);
  if (!c) {
    console.log(`[inbound] ${m.from}: no open case, logged only`);
    return { matched: false };
  }
  await q('UPDATE messages SET case_id = $1 WHERE wa_message_id = $2', [c.id, m.id]);

  const dateLabel = absentDateLabel(c.absent_date, c.code);
  const cls = payload ? { option: payload.option, confidence: 1, ai: false } : await classifyReply(text);

  let reply;
  if (cls.option) {
    reply = systemReply(cls.option, dateLabel);
    await q(
      `UPDATE cases SET status = 'replied', reply_option = $2, reply_text = $3, ai_used = $4, replied_at = now() WHERE id = $1`,
      [c.id, cls.option, text, cls.ai],
    );
  } else {
    reply = clarifyMessage(dateLabel);
    await q(`UPDATE cases SET status = 'needs_hr', reply_text = $2, ai_used = $3, replied_at = now() WHERE id = $1`, [c.id, text, cls.ai]);
  }

  try {
    const res = await sendText(m.from, reply);
    await logMessage({ caseId: c.id, direction: 'out', waMessageId: res.id, waId: m.from, body: reply, status: res.dryRun ? 'dry-run' : 'sent' });
  } catch (err) {
    console.error(`[inbound] reply to case ${c.id} failed:`, err.message);
    await q('UPDATE cases SET error = $2 WHERE id = $1', [c.id, `System reply failed: ${err.message}`]);
    await logMessage({ caseId: c.id, direction: 'out', waMessageId: null, waId: m.from, body: reply, status: `failed: ${err.message}` });
  }
  return { matched: true, caseId: c.id, option: cls.option, ai: cls.ai };
}

// Delivery receipts from Meta: sent -> delivered -> read, or failed.
export async function handleStatus(s) {
  const error = s.errors?.[0] ? `${s.errors[0].code}: ${s.errors[0].title}` : null;
  await q('UPDATE messages SET status = $2 WHERE wa_message_id = $1', [s.id, error ? `failed: ${error}` : s.status]);

  const { rows } = await q('SELECT id, status FROM cases WHERE wa_message_id = $1', [s.id]);
  const c = rows[0];
  if (!c) return;
  if (s.status === 'failed') {
    if (c.status in DELIVERY_RANK) await q(`UPDATE cases SET status = 'failed', error = $2 WHERE id = $1`, [c.id, error]);
  } else if (c.status in DELIVERY_RANK && DELIVERY_RANK[s.status] > DELIVERY_RANK[c.status]) {
    await q('UPDATE cases SET status = $2 WHERE id = $1', [c.id, s.status]);
  }
}

export async function listMessages(caseId) {
  const { rows } = await q(
    'SELECT id, direction, body, status, created_at FROM messages WHERE case_id = $1 ORDER BY created_at, id',
    [caseId],
  );
  return rows;
}

export async function markNoReply({ caseId, olderThanHours } = {}) {
  if (caseId) {
    const { rowCount } = await q(
      `UPDATE cases SET status = 'no_reply' WHERE id = $1 AND status IN ('sent','delivered','read')`,
      [caseId],
    );
    return rowCount;
  }
  const { rowCount } = await q(
    `UPDATE cases SET status = 'no_reply'
     WHERE status IN ('sent','delivered','read') AND sent_at < now() - make_interval(hours => $1)`,
    [olderThanHours],
  );
  return rowCount;
}
