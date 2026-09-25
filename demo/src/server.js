import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { initSchema, getSettings, setSetting, q } from './db.js';
import { importWorkbook } from './importer.js';
import { findFlagged, runCheck, listCases, listMessages, getCase, sendFirstMessage, handleInbound, markNoReply } from './cases.js';
import { absentDateLabel, firstName, firstMessage, OPTIONS } from './flow.js';
import { isDryRun, isConfigured } from './whatsapp.js';
import { aiEnabled } from './classifier.js';
import { webhook } from './webhook.js';
import { startScheduler, todayLocal } from './scheduler.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Public: Meta's webhook + health check.
app.use('/webhook', webhook);
app.get('/health', (_req, res) => res.json({ ok: true }));

// Everything else (dashboard + API) only opens on this computer. ngrok makes the port public,
// but tunnelled requests carry forwarding headers, so they are refused here and only /webhook is reachable.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
app.use((req, res, next) => {
  if (process.env.DASHBOARD_REMOTE_ACCESS === 'true') return next();
  const forwarded = req.get('x-forwarded-for') || req.get('forwarded') || req.get('x-forwarded-host');
  if (LOOPBACK.has(req.socket.remoteAddress) && !forwarded) return next();
  res.status(403).send('The dashboard is only available on the computer running the app (http://localhost).');
});

app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

function requireDate(req) {
  const date = req.body?.date ?? req.query.date;
  if (!DATE_RE.test(date || '')) {
    const err = new Error('date must be YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  return date;
}

app.get('/api/meta', wrap(async (_req, res) => {
  const { rows } = await q('SELECT min(att_date) AS min, max(att_date) AS max, (SELECT count(*) FROM employees)::int AS employees FROM attendance');
  res.json({
    dryRun: isDryRun(),
    whatsappConfigured: isConfigured(),
    aiEnabled: aiEnabled(),
    templateName: process.env.WA_TEMPLATE_NAME || 'attendance_absent_check',
    signatureCheck: Boolean(process.env.WA_APP_SECRET),
    today: todayLocal(),
    data: rows[0],
    options: OPTIONS,
  });
}));

app.get('/api/settings', wrap(async (_req, res) => {
  res.json(await getSettings());
}));

app.put('/api/settings', wrap(async (req, res) => {
  const { check_time, scheduler_enabled } = req.body ?? {};
  if (check_time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(check_time)) return res.status(400).json({ error: 'check_time must be HH:MM' });
    await setSetting('check_time', check_time);
  }
  if (scheduler_enabled !== undefined) await setSetting('scheduler_enabled', scheduler_enabled === true || scheduler_enabled === 'true');
  res.json(await getSettings());
}));

// Who would be messaged for a date (nothing is sent).
app.get('/api/preview', wrap(async (req, res) => {
  const date = requireDate(req);
  const flagged = await findFlagged(date);
  res.json({
    date,
    dryRun: isDryRun(),
    flagged: flagged.map((f) => ({ ...f, message: firstMessage(firstName(f.full_name), f.date_label) })),
  });
}));

app.post('/api/run', wrap(async (req, res) => {
  res.json(await runCheck(requireDate(req)));
}));

app.get('/api/cases', wrap(async (req, res) => {
  const date = req.query.date && DATE_RE.test(req.query.date) ? req.query.date : null;
  res.json(await listCases(date));
}));

app.get('/api/cases/:id/messages', wrap(async (req, res) => {
  const c = await getCase(Number(req.params.id));
  if (!c) return res.sendStatus(404);
  const dateLabel = absentDateLabel(c.absent_date, c.code);
  res.json({ preview: firstMessage(firstName(c.full_name), dateLabel), messages: await listMessages(c.id) });
}));

// Retry a case whose first message failed.
app.post('/api/cases/:id/send', wrap(async (req, res) => {
  const c = await getCase(Number(req.params.id));
  if (!c) return res.sendStatus(404);
  if (!['new', 'failed'].includes(c.status)) return res.status(409).json({ error: `Case is already ${c.status}` });
  res.json(await sendFirstMessage(c.id));
}));

app.post('/api/cases/:id/no-reply', wrap(async (req, res) => {
  res.json({ updated: await markNoReply({ caseId: Number(req.params.id) }) });
}));

// Demo only: pretend the employee replied (button tap or typed text). Disabled when sending for real.
app.post('/api/cases/:id/simulate', wrap(async (req, res) => {
  if (!isDryRun()) return res.status(403).json({ error: 'Simulation is only available in dry-run mode' });
  const c = await getCase(Number(req.params.id));
  if (!c) return res.sendStatus(404);
  const option = Number(req.body?.option);
  const text = String(req.body?.text ?? '').trim();
  const base = { from: c.mobile_e164, id: `sim.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`, timestamp: String(Math.floor(Date.now() / 1000)) };
  const msg = option >= 1 && option <= 4
    ? { ...base, type: 'button', context: { id: c.wa_message_id }, button: { payload: `case:${c.id}:${option}`, text: OPTIONS[option].button } }
    : { ...base, type: 'text', text: { body: text } };
  if (msg.type === 'text' && !text) return res.status(400).json({ error: 'option or text required' });
  res.json(await handleInbound(msg));
}));

app.post('/api/import', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  res.json(await importWorkbook(req.file.buffer));
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

await initSchema();
startScheduler();
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Attendance Agent on http://localhost:${port}`);
  console.log(`  WhatsApp: ${isDryRun() ? 'DRY RUN (nothing is sent)' : 'LIVE'} · AI classifier: ${aiEnabled() ? 'on' : 'off'}`);
  if (!process.env.WA_APP_SECRET) console.warn('  ! WA_APP_SECRET not set: webhook signatures are not checked');
});
