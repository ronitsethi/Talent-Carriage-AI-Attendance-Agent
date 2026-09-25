import OpenAI from 'openai';
import { OPTIONS } from './flow.js';

const client = process.env.OPENAI_API_KEY ? new OpenAI({ timeout: 15000, maxRetries: 1 }) : null;
export const aiEnabled = () => Boolean(client);

const MIN_CONFIDENCE = 0.6;

function byRules(text) {
  const t = text.trim().toLowerCase();
  // "1", "1.", "1)", "option 1", "1 - yes..."
  const m = /^(?:option\s*)?([1-4])(?:\s*[.)\-:]|\s|$)/.exec(t);
  if (m) return Number(m[1]);
  for (const [n, o] of Object.entries(OPTIONS)) {
    if (t === o.label.toLowerCase() || t === o.button.toLowerCase()) return Number(n);
  }
  return null;
}

const SYSTEM_PROMPT = `You classify an employee's WhatsApp reply to an HR attendance question.
The employee was asked why they are marked absent on a date and given four options:
1 = Yes, I was absent (was on leave/sick/personal work and has NOT applied anything yet)
2 = No, I was working (was present, forgot to punch, worked from site/home, biometric issue)
3 = I have already applied leave
4 = I have already sent a regularization request
Reply may be in English, Hindi, Gujarati or Hinglish. If the message does not clearly fit one option
(greetings, questions, complaints, unrelated text), return option 0.
Return JSON only.`;

// Returns { option: 1..4 | null, confidence, ai }
export async function classifyReply(text) {
  const rule = byRules(text || '');
  if (rule) return { option: rule, confidence: 1, ai: false };
  if (!client || !text?.trim()) return { option: null, confidence: 0, ai: false };

  try {
    const res = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text.slice(0, 1000) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'attendance_reply',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              option: { type: 'integer', enum: [0, 1, 2, 3, 4] },
              confidence: { type: 'number' },
            },
            required: ['option', 'confidence'],
            additionalProperties: false,
          },
        },
      },
    });
    const out = JSON.parse(res.choices[0].message.content);
    const ok = out.option >= 1 && out.option <= 4 && out.confidence >= MIN_CONFIDENCE;
    return { option: ok ? out.option : null, confidence: out.confidence, ai: true };
  } catch (err) {
    console.error('[classifier] OpenAI failed:', err.message);
    return { option: null, confidence: 0, ai: true };
  }
}
