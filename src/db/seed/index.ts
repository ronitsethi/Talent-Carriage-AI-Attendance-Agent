import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { closeDb, withPlatformScope, withTenant, type Db } from '@/db';
import {
  codeMappings,
  employees,
  mappingProfiles,
  tenantChannels,
  tenants,
  tenantSettings,
  users,
} from '@/db/schema';
import { importAttendanceFile } from '@/lib/mapping/import';
import { presetByKey, type MappingPreset } from '@/lib/mapping/presets';
import { runDailyCheck } from '@/lib/detection/run';
import { buildContext } from '@/lib/runtime';
import { buildNumericWorkbook, buildRowPerDayWorkbook, generatePeople } from './generate';

/**
 * Three customers whose attendance data looks nothing alike, so the mapping
 * layer is exercised the moment the platform starts - not just in tests.
 *
 * Every number is a test number, and every tenant starts with sending switched
 * on against the fake channel, which delivers to nobody.
 */

const DEMO_FILE = path.join(process.cwd(), 'demo', 'DEMO_Attendance_data_v1.0.xlsx');
const PASSWORD = 'attendance123';

type SeedTenant = {
  slug: string;
  name: string;
  preset: string;
  settings?: Partial<typeof tenantSettings.$inferInsert>;
  /** Applied to every employee this seed imports. */
  employeeDefaults?: { preferredChannel?: string; operatingMode?: string };
  filename?: string;
  file: () => Buffer;
  /** Dates to run the daily check for, so the dashboard has something in it. */
  runDates: string[];
};

const TENANTS: SeedTenant[] = [
  {
    // The company used for live testing: one employee, absent all September,
    // set to Call so the phone flow can be demonstrated end to end.
    slug: 'demo-industries',
    name: 'Demo Industries',
    preset: 'single_code_row_per_day',
    filename: 'demo-industries-september-2026.csv',
    settings: {
      defaultChannel: 'voice',
      callerId: '+912269871077',
      sendingEnabled: true,
      operatingMode: 'manual',
      contactLagDays: 1,
    },
    employeeDefaults: { preferredChannel: 'voice', operatingMode: 'manual' },
    // A real CSV on disk, exactly as a customer would hand it over.
    file: () => fs.readFileSync(path.join(process.cwd(), 'demo-data', 'demo-industries-september-2026.csv')),
    runDates: ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'],
  },
  {
    slug: 'dpod-lifestyle',
    name: 'DPOD Lifestyle',
    preset: 'timeoffice_two_session',
    settings: { actionsEnabled: true, allowedActions: ['apply_leave', 'apply_regularisation'] },
    file: () => fs.readFileSync(DEMO_FILE),
    runDates: ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'],
  },
  {
    slug: 'northwind-retail',
    name: 'Northwind Retail',
    preset: 'single_code_row_per_day',
    settings: { maxOutstandingQuestions: 3 },
    file: () => buildRowPerDayWorkbook(generatePeople(24, 42, 'NW-'), '2026-08', 31, 42),
    runDates: ['2026-08-18', '2026-08-19'],
  },
  {
    slug: 'sunrise-logistics',
    name: 'Sunrise Logistics',
    preset: 'numeric_day_columns',
    settings: { chaseMeanings: ['leave_unpaid'] },
    file: () => buildNumericWorkbook(generatePeople(16, 7, 'SL-'), '2026-08', 31, 7),
    runDates: ['2026-08-18'],
  },
];

async function ensureTenant(seed: SeedTenant) {
  const preset = presetByKey(seed.preset);

  const tenantId = await withPlatformScope(async (tx) => {
    const existing = await tx.query.tenants.findFirst({ where: eq(tenants.slug, seed.slug) });
    if (existing) {
      console.log(`- ${seed.name}: already seeded, skipping`);
      return null;
    }

    const [tenant] = await tx
      .insert(tenants)
      .values({ slug: seed.slug, name: seed.name, status: 'active', licensedHeadcount: 500 })
      .returning();

    await tx.insert(tenantSettings).values({
      tenantId: tenant!.id,
      sendingEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      ...seed.settings,
    });

    await tx.insert(tenantChannels).values({
      tenantId: tenant!.id,
      kind: 'whatsapp',
      provider: 'fake',
      identifier: 'simulator',
      config: { templateName: 'attendance_absent_check', templateLanguage: 'en', buttonCount: 4 },
    });

    await tx.insert(users).values({
      tenantId: tenant!.id,
      email: `hr@${seed.slug}.test`,
      name: `${seed.name} HR`,
      role: 'hr_admin',
      passwordHash: await bcrypt.hash(PASSWORD, 10),
    });

    await createProfile(tx, tenant!.id, preset);
    return tenant!.id;
  });

  if (!tenantId) return;

  // Import and run inside the tenant's own scope, exactly as the app does.
  await withTenant(tenantId, async (tx) => {
    const result = await importAttendanceFile(tx, tenantId, seed.file(), {
      source: 'seed',
      filename: seed.filename ?? `${seed.slug}.xlsx`,
    });

    if (seed.employeeDefaults) {
      await tx.update(employees).set(seed.employeeDefaults).where(eq(employees.tenantId, tenantId));
    }
    console.log(
      `- ${seed.name}: ${result.report.employeesCreated} employees, ${result.report.daysImported} days` +
        `${Object.keys(result.report.unmappedCodes).length ? `, unmapped: ${Object.keys(result.report.unmappedCodes).join(', ')}` : ''}`,
    );

    // Customers start in manual mode, so the seed leaves the cases to you:
    // run the check from the portal, or set SEED_RUN_CHECKS=true to prefill.
    if (process.env.SEED_RUN_CHECKS !== 'true') {
      console.log(`  no cases created - run the check from the portal for ${seed.runDates.join(', ')}`);
      return;
    }
    const ctx = await buildContext(tx, tenantId);
    for (const date of seed.runDates) {
      const run = await runDailyCheck(ctx, { date, trigger: 'manual' });
      console.log(`  ${date}: ${run.gapsFound} gaps, ${run.casesCreated} cases, ${run.messagesSent} messages`);
    }
  });
}

async function createProfile(tx: Db, tenantId: string, preset: MappingPreset) {
  const [profile] = await tx
    .insert(mappingProfiles)
    .values({
      tenantId,
      name: preset.label,
      status: 'active',
      hrmsHint: preset.hrmsHint,
      fieldMap: preset.fieldMap,
      notes: preset.description,
      activatedAt: new Date(),
    })
    .returning();

  if (preset.codes.length) {
    await tx.insert(codeMappings).values(
      preset.codes.map((code) => ({
        tenantId,
        profileId: profile!.id,
        code: code.code.toUpperCase(),
        meaning: code.meaning,
        chase: code.chase ?? null,
        confirmedAt: new Date(),
      })),
    );
  }
  return profile!;
}

async function ensurePlatformAdmin() {
  await withPlatformScope(async (tx) => {
    const existing = await tx.query.users.findFirst({ where: eq(users.email, 'admin@talentcarriage.test') });
    if (existing) return;
    await tx.insert(users).values({
      email: 'admin@talentcarriage.test',
      name: 'Talent Carriage Admin',
      role: 'platform_admin',
      passwordHash: await bcrypt.hash(PASSWORD, 10),
    });
  });
}

async function main() {
  console.log('Seeding demo customers...');
  await ensurePlatformAdmin();
  for (const seed of TENANTS) await ensureTenant(seed);
  console.log(`\nSign in with any listed email and the password "${PASSWORD}".`);
  await closeDb();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
