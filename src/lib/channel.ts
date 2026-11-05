import type { EmployeeRow, TenantSettings } from '@/lib/conversation/engine';

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

/** A follow-up goes the way its level is set for the customer, else the employee's way. */
export function followUpChannel(employee: EmployeeRow, settings: TenantSettings, level: number) {
  return settings.followUpContacts[level - 1]?.channel ?? channelFor(employee, settings.defaultChannel);
}
