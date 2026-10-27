/**
 * Creates the WhatsApp templates the app sends and Meta must approve: the three
 * for tickets, the first question with its new options, the manager's
 * approval request, and the decision told to the employee.
 *
 *   WA_ACCESS_TOKEN=... npx tsx scripts/create-ticket-templates.ts <WABA id>
 *   npx tsx scripts/create-ticket-templates.ts <WABA id> --print    # shows what would be sent
 *   npx tsx scripts/create-ticket-templates.ts <WABA id> manager_approval_request   # just the ones named
 *
 * The names are the ones the app sends (TICKET_TEMPLATES), and each body's
 * variables are filled in the same order `ticket-whatsapp.ts` fills them. A
 * template that already exists is reported, not changed: editing an approved
 * template sends it back for review.
 */
import { TICKET_TEMPLATES } from '@/lib/ticket-whatsapp';
import { FIRST_STEP_TEMPLATE, OPTIONS } from '@/lib/conversation/flow';
import { MANAGER_TEMPLATE, MANAGER_TEMPLATE_BODY, NOTED_TEMPLATE, NOTED_TEMPLATE_BODY, OUTCOME_TEMPLATE } from '@/lib/approvals';

const RESOLVED = { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Resolved' }] };

// The first question with its new options, and the manager's approval request.
const ATTENDANCE_TEMPLATES = [
  {
    name: FIRST_STEP_TEMPLATE,
    body: 'Hi {{1}}, our attendance record shows you are marked absent on {{2}}. Please confirm the reason by choosing one option below.',
    example: ['Aryan', '08-Sep-2026'],
    buttons: [OPTIONS[1].templateButton, OPTIONS[2].templateButton, OPTIONS[3].templateButton, OPTIONS[4].templateButton],
  },
  {
    name: MANAGER_TEMPLATE,
    body: MANAGER_TEMPLATE_BODY,
    example: ['Aryan Jain (DI-1001)', 'has applied leave', '08-Sep-2026', 'Unwell'],
    buttons: ['Approved', 'Rejected'],
  },
  {
    // To the manager, once the employee is told, when the manager's own window has closed.
    name: NOTED_TEMPLATE,
    body: NOTED_TEMPLATE_BODY,
    example: ['Noted - approved. Aryan Jain has been told on WhatsApp.'],
    buttons: [],
  },
  {
    // The manager's decision, for an employee whose 24-hour window has closed.
    name: OUTCOME_TEMPLATE,
    body: 'Hi {{1}}, an update on your {{2}} for {{3}}: {{4}}\n\nReply here if you have any questions.',
    example: ['Aryan', 'leave', '08-Sep-2026', 'Deepak has approved it.'],
    buttons: [],
  },
];

const TEMPLATES = [
  {
    name: TICKET_TEMPLATES.assigned,
    body:
      'New ticket {{1}} has been assigned to you.\n\nEmployee: {{2}}, {{3}}\nQuery type: {{4}}\nPriority: {{5}}\n\n{{6}}\n\n' +
      'Reply to this message once it is resolved.',
    example: [
      'TKT-00012',
      'Aryan Jain (DI-1001)',
      'Demo Industries',
      'Resignation/Notice Period/FnF/No Dues/Employement Certificate',
      'High',
      'Aryan Jain left on 30 September 2026 and his full and final settlement has not been paid. He is also waiting for his relieving letter.',
    ],
  },
  {
    name: TICKET_TEMPLATES.reminder,
    body:
      'You have not resolved ticket {{1}} for {{2}}, {{3}}, yet. If it is not resolved within the next 12 hours, it will be escalated to the LT person {{4}}.\n\n' +
      'Reply to the ticket message once it is resolved.',
    example: ['TKT-00012', 'Aryan Jain (DI-1001)', 'Demo Industries', 'Jeet Vishnubhai Pawar'],
  },
  {
    name: TICKET_TEMPLATES.escalated,
    body:
      'Ticket {{1}} for {{2}}, {{3}}, was not resolved by {{4}} within 48 hours and has been escalated to you.\n\nQuery type: {{5}}\nPriority: {{6}}\n\n{{7}}\n\n' +
      'Reply to this message once it is resolved.',
    example: [
      'TKT-00012',
      'Aryan Jain (DI-1001)',
      'Demo Industries',
      'Honey Pawar',
      'Resignation/Notice Period/FnF/No Dues/Employement Certificate',
      'High',
      'Aryan Jain left on 30 September 2026 and his full and final settlement has not been paid. He is also waiting for his relieving letter.',
    ],
  },
];

async function main() {
  const [waba, ...rest] = process.argv.slice(2);
  const flag = rest.find((arg) => arg.startsWith('--'));
  const only = rest.filter((arg) => !arg.startsWith('--'));
  if (!waba || !/^\d+$/.test(waba)) throw new Error('Give the WhatsApp Business account id, e.g. 1185067337113062');
  const version = process.env.WA_GRAPH_VERSION || 'v21.0';

  const payloads = [
    ...TEMPLATES.map((t) => ({
      name: t.name,
      language: 'en',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: t.body, example: { body_text: [t.example] } }, RESOLVED],
    })),
    ...ATTENDANCE_TEMPLATES.map((t) => ({
      name: t.name,
      language: 'en',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: t.body, example: { body_text: [t.example] } },
        ...(t.buttons.length ? [{ type: 'BUTTONS', buttons: t.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) }] : []),
      ],
    })),
  ].filter((payload) => !only.length || only.includes(payload.name));
  if (flag === '--print') {
    console.log(JSON.stringify(payloads, null, 2));
    return;
  }

  const token = process.env.WA_ACCESS_TOKEN;
  if (!token) throw new Error('WA_ACCESS_TOKEN is not set');
  for (const payload of payloads) {
    const response = await fetch(`https://graph.facebook.com/${version}/${waba}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const answer = (await response.json().catch(() => ({}))) as { id?: string; status?: string; error?: { message?: string; error_user_msg?: string } };
    if (response.ok) console.log(`${payload.name}: created, ${answer.status ?? 'submitted'} (id ${answer.id})`);
    else console.log(`${payload.name}: NOT created - ${answer.error?.error_user_msg ?? answer.error?.message ?? response.status}`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
