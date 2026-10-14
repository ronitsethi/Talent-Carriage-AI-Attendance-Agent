import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { cases } from '@/db/schema';
import { ChannelError, type MessageChannel } from '@/lib/channels/types';
import { contactCaseById } from '@/lib/contact';
import { runDailyCheck } from '@/lib/detection/run';
import { giveAttendance, makeScenario, type Scenario } from './helpers/scenario';

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

describe('a provider refusing a message', () => {
  it('is reported on the case instead of failing the request', async () => {
    scenario = await makeScenario();
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-08-18', meaning: 'absent_full', raw: 'A|A' },
      ]);
      await runDailyCheck(scenario.context(tx), { date: '2026-08-18', trigger: 'manual' });
    });

    const refusing: MessageChannel = {
      ...scenario.channel,
      name: 'meta',
      capabilities: scenario.channel.capabilities,
      send: async () => {
        throw new ChannelError('Template name does not exist in the translation', 132001);
      },
    };

    await withTenant(scenario.tenantId, async (tx) => {
      const [row] = await tx.select().from(cases).where(eq(cases.tenantId, scenario.tenantId));
      const outcome = await contactCaseById({ ...scenario.context(tx), channel: refusing }, row!.id);
      expect(outcome).toMatchObject({ contacted: false, reason: expect.stringContaining('Template name') });
      const [after] = await tx.select().from(cases).where(eq(cases.id, row!.id));
      expect(after!.error).toContain('Template name');
    });
  });
});
