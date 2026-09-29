import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { withPlatformScope } from '@/db';
import { attendanceDays, employees, tenants, tenantSettings } from '@/db/schema';
import { FakeChannel } from '@/lib/channels/fake';
import type { InboundMessage } from '@/lib/channels/types';
import type { TenantSettings } from '@/lib/conversation/engine';
import { FakeVoiceProvider } from '@/lib/voice/fake';
import type { FullContext } from '@/lib/runtime';
import type { Meaning } from '@/lib/mapping/meanings';

export type Scenario = {
  tenantId: string;
  employeeId: string;
  mobile: string;
  channel: FakeChannel;
  /** The fake phone line, for scenarios that put an employee on Call. */
  voice: FakeVoiceProvider;
  /** The fake conversational line, for employees set to a talking call. */
  voiceAgent: FakeVoiceProvider;
  context: (tx: Db) => FullContext;
  cleanup: () => Promise<void>;
};

/** A tenant with one employee, ready for the engine. Sending is on; the channel is fake. */
export async function makeScenario(
  overrides: Partial<TenantSettings> = {},
  employeeOverrides: Partial<typeof employees.$inferInsert> = {},
): Promise<Scenario> {
  const channel = new FakeChannel();
  const voice = new FakeVoiceProvider();
  // A second line, so a test can prove which of the two a call actually used.
  const voiceAgent = new FakeVoiceProvider('livekit');
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const mobile = `9190000${String(Math.floor(Math.random() * 90000) + 10000)}`;

  const { tenantId, employeeId, settings } = await withPlatformScope(async (tx) => {
    const [tenant] = await tx.insert(tenants).values({ slug, name: `Test ${slug}`, status: 'active' }).returning();
    const [row] = await tx
      .insert(tenantSettings)
      .values({
        tenantId: tenant!.id,
        sendingEnabled: true,
        // Quiet hours would make tests depend on the clock, so they are open here.
        quietHoursStart: '00:00',
        quietHoursEnd: '00:00',
        ...overrides,
      })
      .returning();
    const [employee] = await tx
      .insert(employees)
      .values({
        tenantId: tenant!.id,
        empCode: 'E-1',
        fullName: 'Ankit Panwar',
        mobileE164: mobile,
        department: 'Operations',
        ...employeeOverrides,
      })
      .returning();
    return { tenantId: tenant!.id, employeeId: employee!.id, settings: row! };
  });

  return {
    tenantId,
    employeeId,
    mobile,
    channel,
    voice,
    voiceAgent,
    context: (tx: Db) => ({
      tx,
      tenantId,
      settings,
      channel,
      voice,
      voiceAgent,
      baseUrl: 'http://localhost:3000',
      hrms: null,
      companyName: 'Test Co',
      template: { name: 'attendance_absent_check', language: 'en', buttonCount: 4 },
    }),
    cleanup: async () => {
      await withPlatformScope((tx) => tx.delete(tenants).where(eq(tenants.id, tenantId)));
    },
  };
}

/** Gives the employee attendance on a set of dates. */
export async function giveAttendance(
  tx: Db,
  tenantId: string,
  employeeId: string,
  days: { date: string; meaning: Meaning; raw?: string; working?: boolean }[],
) {
  await tx.insert(attendanceDays).values(
    days.map((d) => ({
      tenantId,
      employeeId,
      attDate: d.date,
      meaning: d.meaning,
      rawStatus: d.raw ?? d.meaning,
      isWorkingDay: d.working ?? true,
    })),
  );
}

/** An employee tapping a button or list row: the payload names the case. */
export function tapOption(from: string, selectionId: string, title = 'option'): InboundMessage {
  return {
    providerMessageId: `wamid.${randomUUID()}`,
    from,
    kind: 'button',
    selectionId,
    selectionTitle: title,
    text: title,
    receivedAt: new Date(),
    raw: { type: 'button' },
  };
}

/** An employee typing something. */
export function typeText(from: string, text: string, replyToProviderId?: string): InboundMessage {
  return {
    providerMessageId: `wamid.${randomUUID()}`,
    from,
    kind: 'text',
    text,
    replyToProviderId,
    receivedAt: new Date(),
    raw: { type: 'text', text: { body: text } },
  };
}
