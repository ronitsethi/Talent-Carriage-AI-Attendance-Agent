import { OPTIONS } from './flow.js';

export const isDryRun = () => process.env.WA_DRY_RUN !== 'false';

export function isConfigured() {
  return Boolean(process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN);
}

async function post(body) {
  if (isDryRun()) {
    return { id: `dry.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`, dryRun: true };
  }
  if (!isConfigured()) throw new Error('WhatsApp is not configured (WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN)');

  const version = process.env.WA_GRAPH_VERSION || 'v23.0';
  const res = await fetch(`https://graph.facebook.com/${version}/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...body }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    throw new Error(e.error_user_msg || e.message || `WhatsApp API HTTP ${res.status}`);
  }
  return { id: json.messages?.[0]?.id, dryRun: false };
}

// First message: must be the approved template because the business starts the conversation.
// Each quick-reply button carries "case:<id>:<option>" so the reply maps straight back to its case.
export function sendAbsentTemplate(to, { name, dateLabel, caseId }) {
  const buttonCount = Number(process.env.WA_TEMPLATE_BUTTONS ?? 4);
  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: name },
        { type: 'text', text: dateLabel },
      ],
    },
  ];
  for (let i = 0; i < buttonCount && i < 4; i++) {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(i),
      parameters: [{ type: 'payload', payload: `case:${caseId}:${i + 1}` }],
    });
  }
  return post({
    to,
    type: 'template',
    template: {
      name: process.env.WA_TEMPLATE_NAME || 'attendance_absent_check',
      language: { code: process.env.WA_TEMPLATE_LANG || 'en' },
      components,
    },
  });
}

// Replies inside the 24h customer-service window can be free-form text.
export function sendText(to, text) {
  return post({ to, type: 'text', text: { preview_url: false, body: text } });
}

export { OPTIONS };
