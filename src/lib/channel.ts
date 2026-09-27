import type { EmployeeRow } from '@/lib/conversation/engine';

/**
 * Which channel an employee is contacted on.
 *
 * It lives on its own, with no other imports, because everything that reaches
 * somebody needs it - messages, calls and reminders alike - and routing it
 * through any one of those would tie them all together.
 */
export function channelFor(employee: EmployeeRow, fallback: string): 'whatsapp' | 'voice' {
  const choice = employee.preferredChannel || fallback;
  return choice === 'voice' ? 'voice' : 'whatsapp';
}
