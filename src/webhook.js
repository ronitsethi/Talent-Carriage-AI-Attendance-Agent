import crypto from 'node:crypto';
import { Router } from 'express';
import { handleInbound, handleStatus } from './cases.js';

export const webhook = Router();

// Meta calls this once when the Callback URL is saved in the app dashboard.
webhook.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token && token === process.env.WA_VERIFY_TOKEN) {
    console.log('[webhook] verified by Meta');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function validSignature(req) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) return true; // not configured yet: accept (warned at startup)
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

webhook.post('/', async (req, res) => {
  if (!validSignature(req)) {
    console.warn('[webhook] rejected: bad X-Hub-Signature-256');
    return res.sendStatus(401);
  }
  // Acknowledge fast; Meta retries if we take too long.
  res.sendStatus(200);

  try {
    for (const entry of req.body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const v = change.value ?? {};
        for (const s of v.statuses ?? []) await handleStatus(s);
        for (const m of v.messages ?? []) {
          const r = await handleInbound(m);
          console.log(`[webhook] message from ${m.from}:`, r);
        }
      }
    }
  } catch (err) {
    console.error('[webhook] processing error:', err);
  }
});
