import { eq } from 'drizzle-orm';
import { employees, messages, queries } from '@/db/schema';
import { canSend, deliver, getConversation, sendPlainText, windowOpen, type EngineContext } from './engine';

/**
 * Telling the employee about the ticket raised from their query: that it is
 * logged when it is raised, and that it is resolved when it is closed - by the
 * COE person on WhatsApp or by HR on the portal. The ticket's number is for the
 * COE team and the portal; the employee is not given it.
 *
 * Inside the 24-hour window it is an ordinary message; outside it, the approved
 * template with the same words. Either way it is filed under the query, so it
 * shows in the query's chat, without moving the query's last activity on: a
 * reply to it days later starts a query of its own, which gets its own look.
 */

export const EMPLOYEE_TICKET_TEMPLATES = {
  raised: 'employee_ticket_raised',
  resolved: 'employee_ticket_resolved',
} as const;

export const EMPLOYEE_TICKET_BODIES = {
  raised: 'Hi {{1}}, your query has been logged as a ticket. Our team will look into it, and you will be told here once it is resolved.',
  resolved: 'Hi {{1}}, your ticket has been resolved. If anything is still not right, reply here within 7 days and we will raise it again.',
} as const;

export type TicketEvent = keyof typeof EMPLOYEE_TICKET_TEMPLATES;

const fill = (body: string, variables: string[]) => variables.reduce((text, value, index) => text.replace(`{{${index + 1}}}`, value), body);

export async function tellEmployeeAboutTicket(
  ctx: EngineContext,
  queryId: string,
  event: TicketEvent,
): Promise<{ sent: boolean; reason?: string }> {
  const query = await ctx.tx.query.queries.findFirst({ where: eq(queries.id, queryId) });
  if (!query?.ticketStatus) return { sent: false, reason: 'no ticket' };
  // A notice that no longer says what is true is not sent: "raised" for a ticket closed since, "resolved" for one open.
  if (event === 'raised' && query.ticketStatus !== 'open') return { sent: false, reason: 'already resolved' };
  if (event === 'resolved' && query.ticketStatus !== 'resolved') return { sent: false, reason: 'not resolved' };

  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, query.employeeId) });
  if (!employee) return { sent: false, reason: 'no employee' };
  const block = canSend(ctx, employee);
  if (block.blocked) return { sent: false, reason: block.reason };

  const name = employee.fullName.split(/\s+/)[0] ?? employee.fullName;
  const variables = [name];
  const body = fill(EMPLOYEE_TICKET_BODIES[event], variables);
  const conversation = await getConversation(ctx, employee.id);
  const templateName = EMPLOYEE_TICKET_TEMPLATES[event];

  const sent = windowOpen(conversation, new Date())
    ? await sendPlainText(ctx, employee, body)
    : await deliver(
        ctx,
        employee,
        { kind: 'template', to: employee.mobileE164!, templateName, language: 'en', variables, preview: body },
        { kind: 'template', body, templateName },
      );

  await ctx.tx.update(messages).set({ queryId }).where(eq(messages.id, sent.messageId));
  return { sent: true };
}
