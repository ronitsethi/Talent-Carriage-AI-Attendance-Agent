import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { employees, tenantChannels, tenants, tenantSettings } from '@/db/schema';
import { FakeChannel } from '@/lib/channels/fake';
import { MetaWhatsAppChannel } from '@/lib/channels/meta';
import type { MessageChannel } from '@/lib/channels/types';
import { handleApprovalDecision, handleOfferResponse, offerAction, type ActionContext } from '@/lib/actions/engine';
import { handleFollowUpResponse } from '@/lib/conversation/followup';
import { MockHrms } from '@/lib/hrms/mock';
import type { HrmsConnector } from '@/lib/hrms/types';
import { FakeVoiceProvider } from '@/lib/voice/fake';
import { PlivoVoiceProvider } from '@/lib/voice/plivo';
import type { VoiceProvider } from '@/lib/voice/types';
import type { VoiceContext } from '@/lib/voice/session';
import { env } from '@/lib/env';

/**
 * Builds the context every operation runs in: which channel, which HRMS, which
 * hooks. This is the one place that decides fake or real, so switching a tenant
 * to live WhatsApp is a configuration change and nothing more.
 */

const fakeChannels = new Map<string, FakeChannel>();
const fakeVoice = new Map<string, FakeVoiceProvider>();
const mockHrmsByTenant = new Map<string, MockHrms>();

/** The fake channel for a tenant, so the simulator screen can read its history. */
export function fakeChannelFor(tenantId: string): FakeChannel {
  let channel = fakeChannels.get(tenantId);
  if (!channel) {
    channel = new FakeChannel();
    fakeChannels.set(tenantId, channel);
  }
  return channel;
}

export async function mockHrmsFor(tx: Db, tenantId: string): Promise<MockHrms> {
  let hrms = mockHrmsByTenant.get(tenantId);
  if (hrms) return hrms;

  hrms = new MockHrms({ backdatingWindowDays: 365, maxRegularisationsPerMonth: 5 });
  const people = await tx.select({ empCode: employees.empCode }).from(employees).where(eq(employees.tenantId, tenantId));
  for (const person of people) hrms.seed({ employeeCode: person.empCode });
  mockHrmsByTenant.set(tenantId, hrms);
  return hrms;
}

async function resolveChannel(tx: Db, tenantId: string): Promise<MessageChannel> {
  const configured = await tx.query.tenantChannels.findFirst({
    where: eq(tenantChannels.tenantId, tenantId),
  });

  const config = (configured?.config ?? {}) as { phoneNumberId?: string; accessToken?: string };
  const phoneNumberId = config.phoneNumberId ?? env.WA_PHONE_NUMBER_ID;
  const accessToken = config.accessToken ?? env.WA_ACCESS_TOKEN;

  // Real credentials and the brake off: talk to Meta. Anything else: the fake.
  if (!env.DRY_RUN && phoneNumberId && accessToken) {
    return new MetaWhatsAppChannel({ phoneNumberId, accessToken, graphVersion: env.WA_GRAPH_VERSION });
  }
  return fakeChannelFor(tenantId);
}

/** The fake phone line for a tenant, so tests and the portal can inspect it. */
export function fakeVoiceFor(tenantId: string): FakeVoiceProvider {
  let provider = fakeVoice.get(tenantId);
  if (!provider) {
    provider = new FakeVoiceProvider();
    fakeVoice.set(tenantId, provider);
  }
  return provider;
}

function resolveVoice(tenantId: string): VoiceProvider {
  const configured = env.PLIVO_AUTH_ID && env.PLIVO_AUTH_TOKEN;
  if (!env.DRY_RUN && env.VOICE_PROVIDER === 'plivo' && configured) {
    return new PlivoVoiceProvider({ authId: env.PLIVO_AUTH_ID!, authToken: env.PLIVO_AUTH_TOKEN! });
  }
  return fakeVoiceFor(tenantId);
}

async function resolveHrms(tx: Db, tenantId: string): Promise<HrmsConnector | null> {
  switch (env.HRMS_CONNECTOR) {
    case 'mock':
      return mockHrmsFor(tx, tenantId);
    case 'none':
      return null;
    default:
      // The REST and file connectors arrive with a customer's credentials; until
      // then the mock stands in so the flow is complete rather than half-built.
      return mockHrmsFor(tx, tenantId);
  }
}

export type FullContext = ActionContext & VoiceContext;

export async function buildContext(tx: Db, tenantId: string): Promise<FullContext> {
  const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw new Error(`Unknown tenant ${tenantId}`);
  const settings = await tx.query.tenantSettings.findFirst({ where: eq(tenantSettings.tenantId, tenantId) });
  if (!settings) throw new Error(`Tenant ${tenantId} has no settings row`);

  const channelRow = await tx.query.tenantChannels.findFirst({ where: eq(tenantChannels.tenantId, tenantId) });
  const templateConfig = (channelRow?.config ?? {}) as { templateName?: string; templateLanguage?: string; buttonCount?: number };

  const hrms = await resolveHrms(tx, tenantId);

  return {
    tx,
    tenantId,
    settings,
    channel: await resolveChannel(tx, tenantId),
    voice: resolveVoice(tenantId),
    baseUrl: env.APP_BASE_URL,
    companyName: tenant.name,
    template: {
      name: templateConfig.templateName ?? 'attendance_absent_check',
      language: templateConfig.templateLanguage ?? settings.defaultLanguage,
      buttonCount: templateConfig.buttonCount ?? 4,
    },
    hrms,
    hooks: {
      onAnswered: (ctx, caseRow, employee, option) =>
        offerAction({ ...(ctx as ActionContext), hrms }, caseRow, employee, option),
      onOfferResponse: async (ctx, caseRow, employee, choice) => {
        await handleOfferResponse({ ...(ctx as ActionContext), hrms }, caseRow, employee, choice);
      },
      onApprovalDecision: async (ctx, approvalId, choice, approver) => {
        await handleApprovalDecision({ ...(ctx as ActionContext), hrms }, approvalId, choice, approver);
      },
      onFollowUpResponse: async (ctx, caseRow, employee, choice) => {
        await handleFollowUpResponse(ctx, caseRow, employee, choice);
      },
    },
  };
}
